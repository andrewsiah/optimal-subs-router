// Replay a request log against several subscription accounts and compare
// routing policies: the rotation rule, a fixed order, and round-robin.
//
// Model (deterministic, one-minute steps):
// - Each account has a weekly allowance that renews on a fixed 7-day cycle.
// - An account with a 5-hour window can spend at most `fiveHourPct` percent of
//   its weekly allowance per window. The window starts at the first request
//   after the previous one ended (vendor semantics), not on a clock.
// - Optionally an account can burn at most `maxPctPerHour` of its weekly
//   allowance per hour (the fastest you've seen it drain). Leave it out for no cap.
// - Requests go to the first account in the order with room; what it can't take
//   spills to the next. Work nobody can take is "unserved" (in real life it
//   fails or goes to a paid fallback).
// - The same 98% guard as the rule applies: windows stop at 98%.
//
// Accounts: [{ id, weeklyResetsAt: ISO (any week; only the phase matters),
//              weeklyWork: work units one weekly allowance holds,
//              fiveHourPct: number | null, maxPctPerHour?: number }]
// Demand:   [{ t: ISO, work }] or [{ t, in, out, cache_read, cache_write }]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FULL, HOLD_MS, compareAccounts } from './rotation.mjs';

export const HOUR = 3_600_000;
export const FIVE_HOURS = 5 * HOUR;
export const WEEK = 7 * 24 * HOUR;
const RESERVE = 100 - FULL;

// One number per request so the same demand can be replayed on different
// plans. Output and cache writes cost more quota than input; cache reads less.
// Calibrate weeklyWork with the same formula (see SKILL.md).
const TOKEN_FIELDS = ['in', 'out', 'cache_read', 'cache_write'];
// Returns NaN for a row with no work data, or a negative or non-numeric value, so callers
// can drop it. A row with some token fields counts the missing ones as 0.
export function workUnits(row) {
  const count = value => (value === undefined ? 0 : Number.isFinite(value) && value >= 0 ? value : NaN);
  if ('work' in row) return count(row.work);
  if (!TOKEN_FIELDS.some(k => k in row)) return NaN;
  return count(row.in) + 5 * count(row.out) + 0.1 * count(row.cache_read) + 1.25 * count(row.cache_write);
}
const validRow = r => Number.isFinite(Date.parse(r.t)) && Number.isFinite(workUnits(r));

// Repeat one week of demand `weeks` times so the first week can warm up.
export function tileWeek(rows, weekEnd, weeks) {
  const end = Date.parse(weekEnd), out = [];
  const week = rows.filter(r => Date.parse(r.t) >= end - WEEK && Date.parse(r.t) < end);
  for (let k = weeks - 1; k >= 0; k--) for (const r of week) if (validRow(r)) out.push({ at: Date.parse(r.t) - k * WEEK, work: workUnits(r) });
  return out.sort((a, b) => a.at - b.at);
}

// Small seeded generator (mulberry32) so random policies and synthetic scenarios replay exactly.
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Policies: 'rule', 'round-robin', 'random' (a fresh random order every minute, failing over
// to the next account with room; `seed` fixes it), or { fixed: [ids] }.
// startUsedPct: how much of each weekly allowance is already used at `start` (0 = full,
// FULL = nothing left until the account's next reset).
export function simulate({ accounts, demand, start, end, policy = 'rule', warmupMs = WEEK, scale = 1, holdMs = HOLD_MS, seed = 1, startUsedPct = 0 }) {
  start = Date.parse(start); end = Date.parse(end);
  if (!(startUsedPct >= 0 && startUsedPct <= 100)) throw new Error('startUsedPct must be between 0 and 100');
  for (const a of accounts) {
    if (!(a.weeklyWork > 0) || !Number.isFinite(Date.parse(a.weeklyResetsAt)) || (a.fiveHourPct != null && !(a.fiveHourPct > 0))) {
      throw new Error(`Account ${a.id}: needs weeklyWork > 0, a valid weeklyResetsAt, and fiveHourPct > 0 or null`);
    }
  }
  const state = accounts.map(a => {
    let reset = Date.parse(a.weeklyResetsAt);
    while (reset - WEEK > start) reset -= WEEK;
    while (reset <= start) reset += WEEK;
    const hasFive = Number.isFinite(a.fiveHourPct);
    return { ...a, pctPerWork: 100 / a.weeklyWork, rate: a.maxPctPerHour ?? Infinity, left: 100 - startUsedPct, weekReset: reset,
      fiveLeft: hasFive ? a.fiveHourPct : Infinity, fiveReset: NaN };
  });
  const measureFrom = start + warmupMs;
  if (!(end > measureFrom)) throw new Error('Nothing to measure: end must be after start + warm-up');
  // Rows without a valid time or work are dropped (and counted), never left to stall the replay.
  const parsed = demand.map(r => ({ at: r.at ?? Date.parse(r.t), work: workUnits(r) * scale }));
  const rows = parsed.filter(r => Number.isFinite(r.at) && Number.isFinite(r.work) && r.work >= 0).sort((a, b) => a.at - b.at);
  const totals = { demand: 0, served: 0, allOutMinutes: 0, unservedMinutes: 0, expiredWeeklyPct: 0, expiredWork: 0, switches: 0, invalidRows: parsed.length - rows.length };
  const random = seededRandom(seed);
  let index = 0, order = [], changedAt = -Infinity, lastServer;
  while (index < rows.length && rows[index].at < start) index++;

  for (let at = start; at < end;) {
    const counting = at >= measureFrom;
    for (const a of state) {
      if (a.fiveReset <= at) { a.fiveLeft = a.fiveHourPct; a.fiveReset = NaN; }
      if (a.weekReset <= at) {
        if (counting) { totals.expiredWeeklyPct += a.left; totals.expiredWork += a.left / a.pctPerWork; }
        a.left = 100; a.weekReset += WEEK;
      }
    }
    // What a quota API would report right now.
    const views = state.map(a => ({
      id: a.id,
      weekly: { used: 100 - a.left, resetsAt: new Date(a.weekReset).toISOString() },
      fiveHour: Number.isFinite(a.fiveHourPct) ? { used: 100 * (1 - a.fiveLeft / a.fiveHourPct),
        resetsAt: new Date(Number.isFinite(a.fiveReset) ? a.fiveReset : at + FIVE_HOURS).toISOString() } : null,
    }));
    const room = new Map(views.map(v => [v.id, v.weekly.used < FULL && (!v.fiveHour || v.fiveHour.used < FULL)]));
    const until = Math.min(at + 60_000, end, ...state.flatMap(a => [a.weekReset, a.fiveReset]).filter(t => t > at));
    const hours = (until - at) / HOUR;
    let work = 0;
    while (index < rows.length && rows[index].at < until) work += rows[index++].work;
    const asked = work;

    const drawn = new Map();
    const take = (id, want) => {
      const a = state.find(x => x.id === id);
      if (!room.get(id) || want <= 0) return 0;
      const pct = Math.max(0, Math.min(want * a.pctPerWork, a.rate * hours - (drawn.get(id) || 0), a.left - RESERVE,
        a.fiveLeft - (Number.isFinite(a.fiveLeft) ? a.fiveHourPct * RESERVE / 100 : 0)));
      if (pct > 0 && Number.isFinite(a.fiveLeft) && !Number.isFinite(a.fiveReset)) a.fiveReset = at + FIVE_HOURS;
      a.left -= pct; a.fiveLeft -= pct; drawn.set(id, (drawn.get(id) || 0) + pct);
      if (pct > 0) {
        if (counting && lastServer !== undefined && lastServer !== id) totals.switches++;
        lastServer = id;
      }
      return pct / a.pctPerWork;
    };

    let candidate;
    if (policy === 'round-robin') {
      // Per-request round-robin is close to an equal split across accounts with room.
      // Water-fill: an account that can't take its share drops out and the rest split what's left.
      let live = views.filter(v => room.get(v.id)).map(v => v.id);
      while (work > 1e-9 && live.length) {
        const share = work / live.length, full = new Set();
        for (const id of live) {
          const got = take(id, share);
          work -= got;
          if (got < share * (1 - 1e-9)) full.add(id);
        }
        live = live.filter(id => !full.has(id));
      }
      candidate = order;
    } else {
      if (policy === 'rule') {
        candidate = views.toSorted((x, y) => compareAccounts(x, y, at)).map(v => v.id);
        const hold = at - changedAt < holdMs && room.get(order[0]);
        if (!hold && candidate.join() !== order.join()) { order = candidate; changedAt = at; }
      } else if (policy === 'random') {
        order = views.map(v => v.id);
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      } else {
        // A fixed order: the router skips accounts that are out of room.
        const rank = id => policy.fixed.indexOf(id);
        order = views.map(v => v.id).sort((x, y) => (room.get(x) === room.get(y) ? rank(x) - rank(y) : room.get(x) ? -1 : 1));
      }
      for (const id of order) work -= take(id, work);
    }
    if (counting) {
      totals.demand += asked; totals.served += asked - work;
      if (![...room.values()].some(Boolean)) totals.allOutMinutes += (until - at) / 60_000;
      if (asked > 0 && work > 0.01 * asked) totals.unservedMinutes += (until - at) / 60_000;
    }
    at = until;
  }
  const weeks = (end - measureFrom) / WEEK;
  return {
    policy: typeof policy === 'string' ? policy : 'fixed:' + policy.fixed.join('>'),
    servedShare: totals.demand > 0 ? totals.served / totals.demand : 1,
    // Hours when no account had quota left, whether or not anything was asked then.
    allOutHoursPerWeek: totals.allOutMinutes / 60 / weeks,
    // Hours when more than 1% of what was asked couldn't be served (quota or burn cap).
    unservedHoursPerWeek: totals.unservedMinutes / 60 / weeks,
    expiredAccountWeeksPerWeek: totals.expiredWeeklyPct / 100 / weeks,
    // Weekly allowance left unused at its reset, in work units (the 98% reserve included).
    expiredWorkPerWeek: totals.expiredWork / weeks,
    // Times consecutive pieces of work landed on different accounts. Per-request
    // round-robin switches on almost every request, more than this one-minute model shows.
    accountSwitchesPerWeek: totals.switches / weeks,
    invalidRows: totals.invalidRows,
  };
}

const permutations = xs => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]));

// The rule, round-robin and every fixed order, on the same demand.
export function comparePolicies({ accounts, demand, start, end, scale = 1 }) {
  const ids = accounts.map(a => a.id);
  const policies = ['rule', 'round-robin', ...(ids.length <= 5 ? permutations(ids).map(fixed => ({ fixed })) : [{ fixed: ids }])];
  const runs = policies.map(policy => simulate({ accounts, demand, start, end, policy, scale }));
  const fixed = runs.filter(r => r.policy.startsWith('fixed:'));
  const summary = key => ({ mean: fixed.reduce((s, r) => s + r[key], 0) / fixed.length,
    min: Math.min(...fixed.map(r => r[key])), max: Math.max(...fixed.map(r => r[key])) });
  return { runs, fixedOrders: Object.fromEntries(['servedShare', 'allOutHoursPerWeek', 'unservedHoursPerWeek', 'accountSwitchesPerWeek'].map(k => [k, summary(k)])) };
}

// node src/simulate.mjs ACCOUNTS.json DEMAND.jsonl WEEK_END_ISO [WEEKS=4] [SCALE=1]
// Tiles the week ending at WEEK_END_ISO, warms up for one week, reports the rest.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [accountsPath, demandPath, weekEnd, weeksArg = '4', scaleArg = '1'] = process.argv.slice(2);
  if (!accountsPath || !demandPath || !Number.isFinite(Date.parse(weekEnd))) {
    console.error('Usage: node src/simulate.mjs ACCOUNTS.json DEMAND.jsonl WEEK_END_ISO [WEEKS=4] [SCALE=1]');
    process.exit(2);
  }
  const accounts = JSON.parse(readFileSync(accountsPath, 'utf8'));
  const rows = readFileSync(demandPath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const weeks = Number(weeksArg), scale = Number(scaleArg), end = Date.parse(weekEnd);
  if (!Number.isInteger(weeks) || weeks < 2 || !(scale > 0)) {
    console.error('WEEKS must be a whole number of at least 2 (the first week is warm-up); SCALE must be above 0');
    process.exit(2);
  }
  const invalidRows = rows.filter(r => !validRow(r)).length;
  const demand = tileWeek(rows, weekEnd, weeks);
  const result = comparePolicies({ accounts, demand, start: new Date(end - weeks * WEEK).toISOString(), end: weekEnd, scale });
  console.log(JSON.stringify({ invalidRows, ...result }, null, 2));
}

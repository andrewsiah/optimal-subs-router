// Synthetic scenarios for the benchmark: LLM subscriptions with 5-hour and weekly
// limits, staggered weekly resets, and a user who keeps sending work. No real logs.
//
// Plan limits are made-up tiers in relative units: 1 unit is one weekly allowance of a
// small personal plan. `fiveHourPct` is how much of the weekly allowance one 5-hour
// window holds. Work is treated as interchangeable across providers (an agent task can
// run on either), which is an assumption.

import { FULL } from './rotation.mjs';
import { HOUR, WEEK, seededRandom } from './simulate.mjs';

export const PLANS = {
  'a-small': { provider: 'a', weeklyUnits: 1, fiveHourPct: 9 },
  'a-medium': { provider: 'a', weeklyUnits: 3.5, fiveHourPct: 14 },
  'a-large': { provider: 'a', weeklyUnits: 6, fiveHourPct: 30 },
  'a-work-seat': { provider: 'a', weeklyUnits: 1.25, fiveHourPct: 10 },
  'b-large': { provider: 'b', weeklyUnits: 5, fiveHourPct: 15 },
  'b-work-seat': { provider: 'b', weeklyUnits: 1, fiveHourPct: 20 },
};

export const ACCOUNT_SETS = {
  // Headline: a personal and a work subscription at each of two providers.
  'two-providers': [
    { id: 'a-personal', plan: 'a-medium' },
    { id: 'a-work', plan: 'a-work-seat' },
    { id: 'b-personal', plan: 'b-large' },
    { id: 'b-work', plan: 'b-work-seat' },
  ],
  // Sensitivity check: small, medium and large plans at one provider.
  'three-plan-sizes': [
    { id: 'small', plan: 'a-small' },
    { id: 'medium', plan: 'a-medium' },
    { id: 'large', plan: 'a-large' },
  ],
};

export const DEMAND_MODELS = {
  // The user keeps sending work all waking hours, every day.
  'keeps-blasting': 'Steady demand 16 hours a day (07:00-23:00), 7 days a week',
  'agents-24-7': 'Steady demand around the clock (agents never stop)',
  'bursty': 'Random work sessions (about 1.5 h on, 2 h off) during waking hours',
  // Same waking hours, but each day's level is random (uniform 0-2x the mean): quiet
  // days leave allowance unspent, busy days need more than one day's share.
  'uneven-days': 'Waking-hours demand whose level changes day to day (uniform 0-2x the mean)',
  'busy-weeks-then-quiet': 'Three busy weeks of waking-hours work, then a quiet week with nothing sent',
  'sprint-weeks': 'A sprint week at 1.6x the mean, then a light week at 0.4x, waking hours',
  'weekdays': 'Busy weekdays 07:00-23:00, quiet weekends with nothing sent',
};

export const WORK_PER_UNIT = 1000; // Work units in one relative plan unit.
const WAKE_HOUR = 7, SLEEP_HOUR = 23, MINUTE = 60_000;
export const BENCH_START = '2026-01-05T00:00:00Z'; // A Monday, so weeks and weekdays line up.
// Steady-state runs start with every weekly allowance spent and warm up for 4 weeks.
// Starting full would hand every policy a bank of unspent allowance the steady state
// doesn't have; near 1x demand it takes months to drain and favours whoever spends it best.
export const WARMUP_WEEKS = 4, MEASURED_WEEKS = 4;

const awake = at => { const h = new Date(at).getUTCHours(); return h >= WAKE_HOUR && h < SLEEP_HOUR; };

// Accounts for one seed. Each plan limit is jittered by up to ±jitter, since the plan numbers
// are approximations. resets: 'random' puts each weekly reset at a random minute of the week;
// 'even' spaces them evenly (one every 42 hours for 4 accounts) from a random start, with the
// accounts in a random order.
export function makeAccounts(set, random, { start = BENCH_START, jitter = 0.25, resets = 'random' } = {}) {
  if (resets !== 'random' && resets !== 'even') throw new Error(`Unknown reset layout: ${resets}`);
  const t0 = Date.parse(start), weekMinutes = WEEK / MINUTE;
  const accounts = ACCOUNT_SETS[set].map(({ id, plan }) => {
    const p = PLANS[plan], wobble = () => 1 + jitter * (2 * random() - 1);
    return {
      id, plan, provider: p.provider,
      weeklyResetsAt: new Date(t0 + Math.floor(random() * weekMinutes) * MINUTE).toISOString(),
      weeklyWork: p.weeklyUnits * WORK_PER_UNIT * wobble(),
      fiveHourPct: p.fiveHourPct * wobble(),
    };
  });
  if (resets === 'even') {
    const n = accounts.length, gap = Math.floor(weekMinutes / n), offset = Math.floor(random() * gap);
    const slots = accounts.map((_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    accounts.forEach((a, i) => { a.weeklyResetsAt = new Date(t0 + (offset + slots[i] * gap) * MINUTE).toISOString(); });
  }
  return accounts;
}

// One-minute demand rows. Over the measured weeks (from week `measureFromWeek` to the end)
// demand totals exactly `intensity` times the accounts' combined weekly allowance per
// week; the warm-up weeks use the same per-minute scale.
export function makeDemand(model, { capacityPerWeek, intensity, random, start = BENCH_START, weeks, measureFromWeek = 0 }) {
  const t0 = Date.parse(start), t1 = t0 + weeks * WEEK, on = [];
  if (model === 'keeps-blasting') for (let at = t0; at < t1; at += MINUTE) on.push(awake(at) ? 1 : 0);
  else if (model === 'agents-24-7') for (let at = t0; at < t1; at += MINUTE) on.push(1);
  else if (model === 'uneven-days') {
    let level = 0;
    for (let at = t0; at < t1; at += MINUTE) {
      if ((at - t0) % (24 * HOUR) === 0) level = 2 * random();
      on.push(awake(at) ? level : 0);
    }
  } else if (model === 'busy-weeks-then-quiet' || model === 'sprint-weeks' || model === 'weekdays') {
    for (let at = t0; at < t1; at += MINUTE) {
      const week = Math.floor((at - t0) / WEEK), weekday = new Date(at).getUTCDay();
      const level = model === 'busy-weeks-then-quiet' ? (week % 4 === 3 ? 0 : 1)
        : model === 'sprint-weeks' ? (week % 2 ? 0.4 : 1.6)
        : (weekday >= 1 && weekday <= 5 ? 1 : 0);
      on.push(awake(at) ? level : 0);
    }
  } else if (model === 'bursty') {
    // Alternate exponential on/off spells (mean 90 / 120 minutes, at least 15 minutes on);
    // nothing runs during sleep.
    let busy = false, left = 0;
    for (let at = t0; at < t1; at += MINUTE) {
      if (left <= 0) { busy = !busy; left = busy ? Math.max(15, -90 * Math.log(1 - random())) : -120 * Math.log(1 - random()); }
      left--;
      on.push(busy && awake(at) ? 1 : 0);
    }
  } else throw new Error(`Unknown demand model: ${model}`);
  const activeMinutes = on.slice(measureFromWeek * WEEK / MINUTE).reduce((s, x) => s + x, 0);
  if (!activeMinutes) throw new Error('Demand model produced no active time in the measured weeks');
  const perMinute = (intensity * capacityPerWeek * (weeks - measureFromWeek)) / activeMinutes;
  const rows = [];
  on.forEach((x, i) => { if (x) rows.push({ at: t0 + i * MINUTE, work: x * perMinute }); });
  return rows;
}

// Everything one benchmark cell needs for one seed. The seed fixes reset times, plan
// jitter and session timing, so every policy sees the same scenario.
// start: 'spent' (steady state, after a warm-up) or 'full' (every account unused, as after a break).
export function makeScenario({ set, model, intensity, seed, start: startState = 'spent', resets = 'random', warmupWeeks = WARMUP_WEEKS, measuredWeeks = MEASURED_WEEKS }) {
  if (startState !== 'spent' && startState !== 'full') throw new Error(`Unknown start state: ${startState}`);
  const random = seededRandom(seed * 7919 + 17);
  const accounts = makeAccounts(set, random, { resets });
  const capacityPerWeek = accounts.reduce((s, a) => s + a.weeklyWork, 0);
  const weeks = warmupWeeks + measuredWeeks;
  const demand = makeDemand(model, { capacityPerWeek, intensity, random, weeks, measureFromWeek: warmupWeeks });
  const start = BENCH_START, end = new Date(Date.parse(start) + weeks * WEEK).toISOString();
  return { accounts, demand, capacityPerWeek, start, end, warmupMs: warmupWeeks * WEEK, startUsedPct: startState === 'spent' ? FULL : 0 };
}


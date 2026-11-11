import { deepEqual, equal, notDeepEqual, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { FULL } from '../src/rotation.mjs';
import { HOUR, WEEK, seededRandom, simulate } from '../src/simulate.mjs';
import { ACCOUNT_SETS, BENCH_START, DEMAND_MODELS, PLANS, makeAccounts, makeDemand, makeScenario } from '../src/synthetic.mjs';
import { CELLS, POLICIES, runJob, summarize } from '../scripts/bench.mjs';

const sum = rows => rows.reduce((s, r) => s + r.work, 0);

test('headline subscriptions: a personal and a work plan at each of two providers', () => {
  deepEqual(ACCOUNT_SETS['two-providers'].map(a => PLANS[a.plan].provider), ['a', 'a', 'b', 'b']);
});

test('makeAccounts: resets fall inside the first week, limits stay within ±25% of the plan', () => {
  for (let seed = 1; seed <= 10; seed++) {
    for (const a of makeAccounts('two-providers', seededRandom(seed))) {
      const offset = Date.parse(a.weeklyResetsAt) - Date.parse(BENCH_START);
      ok(offset >= 0 && offset < WEEK);
      const plan = PLANS[a.plan];
      ok(Math.abs(a.weeklyWork / (plan.weeklyUnits * 1000) - 1) <= 0.25 + 1e-9);
      ok(Math.abs(a.fiveHourPct / plan.fiveHourPct - 1) <= 0.25 + 1e-9);
    }
  }
});

test('makeDemand: every model delivers intensity x capacity per week in total', () => {
  for (const model of Object.keys(DEMAND_MODELS)) {
    const rows = makeDemand(model, { capacityPerWeek: 1000, intensity: 1.1, random: seededRandom(3), weeks: 2 });
    ok(Math.abs(sum(rows) - 2200) < 1e-6, model);
  }
});

test('makeDemand: keeps-blasting is steady 07:00-23:00 and silent at night; 24/7 never stops', () => {
  const blasting = makeDemand('keeps-blasting', { capacityPerWeek: 1000, intensity: 1, random: seededRandom(1), weeks: 1 });
  equal(blasting.length, 7 * 16 * 60);
  ok(blasting.every(r => { const h = new Date(r.at).getUTCHours(); return h >= 7 && h < 23; }));
  equal(new Set(blasting.map(r => r.work)).size, 1);
  equal(makeDemand('agents-24-7', { capacityPerWeek: 1000, intensity: 1, random: seededRandom(1), weeks: 1 }).length, 7 * 24 * 60);
});

test('makeDemand: uneven-days holds one level per day, and the levels differ', () => {
  const rows = makeDemand('uneven-days', { capacityPerWeek: 1000, intensity: 1, random: seededRandom(5), weeks: 1 });
  const byDay = new Map();
  for (const r of rows) { const day = Math.floor((r.at - Date.parse(BENCH_START)) / (24 * HOUR)); byDay.set(day, new Set([...(byDay.get(day) || []), r.work])); }
  ok([...byDay.values()].every(levels => levels.size === 1));
  ok(new Set([...byDay.values()].map(levels => [...levels][0])).size > 1);
});

test('makeScenario: the same seed gives the same scenario, another seed a different one', () => {
  const a = makeScenario({ set: 'two-providers', model: 'bursty', intensity: 1, seed: 4, warmupWeeks: 1, measuredWeeks: 1 });
  const b = makeScenario({ set: 'two-providers', model: 'bursty', intensity: 1, seed: 4, warmupWeeks: 1, measuredWeeks: 1 });
  const c = makeScenario({ set: 'two-providers', model: 'bursty', intensity: 1, seed: 5, warmupWeeks: 1, measuredWeeks: 1 });
  deepEqual(a, b);
  notDeepEqual(a.accounts, c.accounts);
  equal(a.startUsedPct, FULL);
  equal(makeScenario({ set: 'two-providers', model: 'bursty', intensity: 1, seed: 4, start: 'full', warmupWeeks: 0, measuredWeeks: 1 }).startUsedPct, 0);
  throws(() => makeScenario({ set: 'two-providers', model: 'bursty', intensity: 1, seed: 4, start: 'half' }), /start state/);
});

test('steady blasting above capacity: every policy serves the same, all allowance used', () => {
  const s = makeScenario({ set: 'two-providers', model: 'keeps-blasting', intensity: 1.25, seed: 1, warmupWeeks: 2, measuredWeeks: 1 });
  for (const policy of ['rule', 'round-robin', 'random']) {
    const r = simulate({ ...s, policy });
    ok(Math.abs(r.servedShare - 0.98 / 1.25) < 0.002, `${policy} ${r.servedShare}`);
    ok(r.expiredWorkPerWeek / s.capacityPerWeek < 0.0201, `${policy} wasted ${r.expiredWorkPerWeek}`);
  }
});

test('after a break the rule spends the allowance that resets first; round-robin lets some of it expire', () => {
  // Two equal, full accounts; one resets after 2 days, the other after 7. Demand is 1.25x their combined weekly allowance.
  const start = '2026-01-05T00:00:00Z';
  const accounts = [
    { id: 'soon', weeklyResetsAt: '2026-01-07T00:00:00Z', weeklyWork: 1000, fiveHourPct: null },
    { id: 'late', weeklyResetsAt: '2026-01-12T00:00:00Z', weeklyWork: 1000, fiveHourPct: null },
  ];
  const demand = makeDemand('agents-24-7', { capacityPerWeek: 1000, intensity: 2.5, random: seededRandom(1), weeks: 1 });
  const run = policy => simulate({ accounts, demand, start, end: '2026-01-12T00:00:00Z', warmupMs: 0, policy });
  const rule = run('rule'), rr = run('round-robin');
  ok(rule.expiredWorkPerWeek < rr.expiredWorkPerWeek - 100, `${rule.expiredWorkPerWeek} vs ${rr.expiredWorkPerWeek}`);
  ok(rule.servedShare > rr.servedShare + 0.05);
});

test('runJob runs every policy on one scenario; summarize counts wins, ties and losses', () => {
  const cell = { ...CELLS.find(c => c.name === 'two-providers/keeps-blasting'), warmupWeeks: 1, measuredWeeks: 1 };
  const run = runJob({ cell, intensity: 0.5, seed: 1 });
  deepEqual(Object.keys(run), Object.keys(POLICIES));
  for (const p of Object.keys(POLICIES)) equal(run[p].servedPct, 100);
  const fake = d => ({ ...run, rule: { ...run.rule, servedPct: 100 + d } });
  const s = summarize([fake(1), fake(0.05), fake(-0.5), fake(0)]);
  deepEqual([s.ruleMinusRoundRobinServedPts.wins, s.ruleMinusRoundRobinServedPts.ties, s.ruleMinusRoundRobinServedPts.losses], [1, 2, 1]);
  equal(s.ruleMinusRoundRobinServedPts.min, -0.5);
});

test('makeDemand: intensity is exact over the measured weeks, whatever the warm-up held', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const s = makeScenario({ set: 'two-providers', model: 'uneven-days', intensity: 1, seed, warmupWeeks: 2, measuredWeeks: 2 });
    const measured = sum(s.demand.filter(r => r.at >= Date.parse(s.start) + s.warmupMs));
    ok(Math.abs(measured / (2 * s.capacityPerWeek) - 1) < 1e-9, `seed ${seed}: ${measured / (2 * s.capacityPerWeek)}`);
  }
});

test('makeDemand: weekly patterns: quiet fourth week, alternating sprint weeks, quiet weekends', () => {
  const opts = { capacityPerWeek: 1000, intensity: 1, random: seededRandom(1), weeks: 4 };
  const perWeek = rows => [0, 1, 2, 3].map(w => sum(rows.filter(r => Math.floor((r.at - Date.parse(BENCH_START)) / WEEK) === w)));
  const quiet = perWeek(makeDemand('busy-weeks-then-quiet', opts));
  equal(quiet[3], 0);
  ok(quiet[0] > 0 && Math.abs(quiet[0] - quiet[2]) < 1e-6);
  const sprint = perWeek(makeDemand('sprint-weeks', opts));
  ok(Math.abs(sprint[0] / sprint[1] - 4) < 1e-9);
  ok(makeDemand('weekdays', opts).every(r => { const d = new Date(r.at).getUTCDay(); return d >= 1 && d <= 5; }));
});

test('makeAccounts: even resets are one every 42 hours for 4 accounts', () => {
  const offsets = makeAccounts('two-providers', seededRandom(9), { resets: 'even' })
    .map(a => Date.parse(a.weeklyResetsAt) - Date.parse(BENCH_START)).sort((x, y) => x - y);
  ok(offsets[0] >= 0 && offsets[3] < WEEK);
  for (let i = 1; i < 4; i++) equal(offsets[i] - offsets[i - 1], 42 * HOUR);
  throws(() => makeAccounts('two-providers', seededRandom(9), { resets: 'bunched' }), /reset layout/);
});

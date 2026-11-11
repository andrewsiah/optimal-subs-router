import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR, WEEK, comparePolicies, simulate, tileWeek, workUnits } from '../src/simulate.mjs';

const start = '2026-01-05T00:00:00Z';
const end = new Date(Date.parse(start) + 4 * WEEK).toISOString();

// Synthetic, deterministic: 12 busy hours a day, steady demand within them.
function demand(perHour) {
  const rows = [];
  for (let at = Date.parse(start); at < Date.parse(end); at += 10 * 60_000) {
    const hour = new Date(at).getUTCHours();
    if (hour >= 8 && hour < 20) rows.push({ at, work: perHour / 6 });
  }
  return rows;
}

// One account with a tight 5-hour window, two weekly-only accounts resetting on different days.
const accounts = [
  { id: 'weekly-a', weeklyResetsAt: '2026-01-06T22:00:00Z', weeklyWork: 600, fiveHourPct: null },
  { id: 'five-hour', weeklyResetsAt: '2026-01-08T07:00:00Z', weeklyWork: 300, fiveHourPct: 12 },
  { id: 'weekly-b', weeklyResetsAt: '2026-01-10T09:00:00Z', weeklyWork: 600, fiveHourPct: null },
];

test('work units weight output and cache writes above input, cache reads below', () => {
  equal(workUnits({ in: 100, out: 10, cache_read: 1000, cache_write: 8 }), 100 + 50 + 100 + 10);
  equal(workUnits({ work: 7 }), 7);
});

test('tileWeek repeats the last week of demand', () => {
  const week = [{ t: '2026-01-25T10:00:00Z', work: 1 }, { t: '2026-01-01T00:00:00Z', work: 99 }];
  deepEqual(tileWeek(week, '2026-02-01T00:00:00Z', 2).map(r => [new Date(r.at).toISOString(), r.work]),
    [['2026-01-18T10:00:00.000Z', 1], ['2026-01-25T10:00:00.000Z', 1]]);
});

test('low demand: every policy serves everything', () => {
  for (const policy of ['rule', 'round-robin', { fixed: ['weekly-a', 'five-hour', 'weekly-b'] }]) {
    const r = simulate({ accounts, demand: demand(2), start, end, policy });
    equal(r.servedShare, 1, JSON.stringify(policy));
    equal(r.allOutHoursPerWeek, 0);
  }
});

test('demand near capacity: the rule beats a fixed order that leaves the 5-hour account last', () => {
  const rows = demand(17);
  const rule = simulate({ accounts, demand: rows, start, end, policy: 'rule' });
  const fixed = simulate({ accounts, demand: rows, start, end, policy: { fixed: ['weekly-b', 'weekly-a', 'five-hour'] } });
  ok(rule.servedShare > fixed.servedShare + 0.01, `${rule.servedShare} vs ${fixed.servedShare}`);
  ok(rule.allOutHoursPerWeek < fixed.allOutHoursPerWeek);
});

test('nothing is served beyond total weekly capacity', () => {
  const r = simulate({ accounts, demand: demand(100), start, end, policy: 'rule' });
  const capacityPerWeek = accounts.reduce((s, a) => s + a.weeklyWork, 0);
  const demandPerWeek = 100 * 12 * 7;
  ok(r.servedShare * demandPerWeek <= capacityPerWeek * 0.98 + 1e-6);
});

test('a burn cap limits how fast one account drains', () => {
  const capped = accounts.map(a => ({ ...a, maxPctPerHour: 1 }));
  const r = simulate({ accounts: capped, demand: demand(9), start, end, policy: 'rule' });
  ok(r.servedShare < simulate({ accounts, demand: demand(9), start, end, policy: 'rule' }).servedShare);
});

test('comparePolicies runs the rule, round-robin and all 6 fixed orders', () => {
  const result = comparePolicies({ accounts, demand: demand(17), start, end });
  equal(result.runs.length, 8);
  ok(result.fixedOrders.servedShare.min <= result.fixedOrders.servedShare.mean);
  ok(result.fixedOrders.servedShare.mean <= result.fixedOrders.servedShare.max);
  equal(HOUR * 24 * 7, WEEK);
});

// Regressions from review: one-minute replays, no warm-up.
const minute = { start: '2026-01-05T00:00:00Z', end: '2026-01-05T00:01:00Z', warmupMs: 0 };
const fresh = (id, weeklyWork, extra = {}) => ({ id, weeklyResetsAt: '2026-01-12T00:00:00Z', weeklyWork, fiveHourPct: null, ...extra });

test('round-robin hands what a full account cannot take to the others', () => {
  const accounts = [fresh('a', 1), fresh('b', 1), fresh('c', 1000)];
  const demand = [{ at: Date.parse(minute.start), work: 100 }];
  equal(simulate({ ...minute, accounts, demand, policy: 'round-robin' }).servedShare, 1);
});

test('all-out hours count only time with no quota left, not a burn cap', () => {
  const hour = { start: '2026-01-05T00:00:00Z', end: '2026-01-05T01:00:00Z', warmupMs: 0 };
  const capped = simulate({ ...hour, accounts: [fresh('a', 1000, { maxPctPerHour: 1 })], demand: [{ at: Date.parse(hour.start), work: 1 }] });
  equal(capped.allOutHoursPerWeek, 0);
  ok(capped.unservedHoursPerWeek > 0);
  const empty = simulate({ ...hour, accounts: [fresh('a', 1)], demand: [{ at: Date.parse(hour.start), work: 5 }] });
  equal(empty.allOutHoursPerWeek, (59 / 60) * 168); // Out from the second minute on, with no further requests.
});

test('rows with a bad time are dropped and counted, not allowed to stall the replay', () => {
  const accounts = [fresh('a', 100)];
  const valid = [{ at: Date.parse(minute.start), work: 1000 }];
  const clean = simulate({ ...minute, accounts, demand: valid });
  const dirty = simulate({ ...minute, accounts, demand: [{ t: 'invalid', work: 1 }, ...valid] });
  equal(dirty.servedShare, clean.servedShare);
  equal(dirty.invalidRows, 1);
});

test('switches count every change of serving account, including inside a step', () => {
  const two = { start: '2026-01-05T00:00:00Z', end: '2026-01-05T00:02:00Z', warmupMs: 0 };
  const demand = [{ at: Date.parse(two.start), work: 10 }, { at: Date.parse(two.start) + 60_000, work: 10 }];
  const r = simulate({ ...two, accounts: [fresh('a', 1000), fresh('b', 1000)], demand, policy: 'round-robin' });
  equal(r.accountSwitchesPerWeek * (2 / (60 * 24 * 7)), 3);
});

test('a run with no measured time is refused', () => {
  throws(() => simulate({ start: '2026-01-05T00:00:00Z', end: '2026-01-12T00:00:00Z', accounts: [fresh('a', 1)], demand: [] }), /Nothing to measure/);
});

test('work units: missing fields count as 0; negative or non-numeric values make the row invalid', () => {
  equal(workUnits({ in: 10 }), 10);
  ok(Number.isNaN(workUnits({ work: -1 })));
  ok(Number.isNaN(workUnits({ work: 'bad' })));
  ok(Number.isNaN(workUnits({ in: 10, out: -2 })));
  ok(Number.isNaN(workUnits({ t: '2026-01-30T10:00:00Z' })), 'no work data at all');
});

test('CLI counts every invalid input row once', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'rotation-cli-'));
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify([{ id: 'a', weeklyResetsAt: '2026-01-12T00:00:00Z', weeklyWork: 100, fiveHourPct: null }]));
  writeFileSync(join(dir, 'demand.jsonl'), ['{"t":"2026-01-30T10:00:00Z","work":1}', '{"t":"bad","work":1}', '{"t":"2026-01-30T11:00:00Z","work":-1}', '{"t":"2026-01-30T12:00:00Z","work":"x"}', '{"t":"2026-01-30T13:00:00Z"}'].join('\n'));
  const cli = fileURLToPath(new URL('../src/simulate.mjs', import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [cli, join(dir, 'accounts.json'), join(dir, 'demand.jsonl'), '2026-01-31T00:00:00Z', '2'], { encoding: 'utf8' }));
  equal(out.invalidRows, 4);
  equal(out.runs[0].servedShare, 1);
});

test('random policy: the same seed replays exactly; it still serves everything when there is room', () => {
  const rows = demand(9);
  const a = simulate({ accounts, demand: rows, start, end, policy: 'random', seed: 3 });
  deepEqual(a, simulate({ accounts, demand: rows, start, end, policy: 'random', seed: 3 }));
  equal(simulate({ accounts, demand: demand(2), start, end, policy: 'random', seed: 3 }).servedShare, 1);
});

test('expiredWorkPerWeek counts allowance left at reset in work units', () => {
  const week = { start: '2026-01-05T00:00:00Z', end: '2026-01-19T00:00:00Z' };
  const r = simulate({ ...week, accounts: [fresh('a', 500, { weeklyResetsAt: '2026-01-05T12:00:00Z' })], demand: [] });
  equal(r.expiredWorkPerWeek, 500);
  equal(r.expiredAccountWeeksPerWeek, 1);
});

test('startUsedPct: an account that starts spent serves nothing until its reset', () => {
  const day = { start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', warmupMs: 0 };
  const account = fresh('a', 1000, { weeklyResetsAt: '2026-01-05T12:00:00Z' });
  const rows = Array.from({ length: 24 }, (_, h) => ({ at: Date.parse(day.start) + h * HOUR, work: 10 }));
  equal(simulate({ ...day, accounts: [account], demand: rows, startUsedPct: 98 }).servedShare, 0.5);
  equal(simulate({ ...day, accounts: [account], demand: rows }).servedShare, 1);
  throws(() => simulate({ ...day, accounts: [account], demand: rows, startUsedPct: 120 }), /startUsedPct/);
});

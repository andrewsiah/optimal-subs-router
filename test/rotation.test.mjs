import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { decide, hasRoom, orderAccounts, weeklyResetAt } from '../src/rotation.mjs';

const now = Date.parse('2026-01-06T12:00:00Z');
const account = (id, weeklyUsed, weeklyResetsAt, fiveHour = null, extra = {}) =>
  ({ id, weekly: { used: weeklyUsed, resetsAt: weeklyResetsAt }, fiveHour, ...extra });

test('5-hour accounts with room go first, then the soonest weekly reset', () => {
  const accounts = [
    account('weekly-late', 10, '2026-01-10T00:00:00Z'),
    account('weekly-soon', 50, '2026-01-07T00:00:00Z'),
    account('five-hour', 30, '2026-01-12T00:00:00Z', { used: 40, resetsAt: '2026-01-06T14:00:00Z' }),
  ];
  deepEqual(orderAccounts(accounts, now), ['five-hour', 'weekly-soon', 'weekly-late']);
});

test('two 5-hour accounts: the one whose week resets sooner goes first', () => {
  const five = { used: 10, resetsAt: '2026-01-06T15:00:00Z' };
  deepEqual(orderAccounts([
    account('b', 0, '2026-01-09T00:00:00Z', five),
    account('a', 0, '2026-01-08T00:00:00Z', five),
  ], now), ['a', 'b']);
});

test('a full 5-hour window drops the account behind every account with room', () => {
  const accounts = [
    account('five-hour', 30, '2026-01-07T00:00:00Z', { used: 98, resetsAt: '2026-01-06T14:00:00Z' }),
    account('weekly', 10, '2026-01-10T00:00:00Z'),
  ];
  deepEqual(orderAccounts(accounts, now), ['weekly', 'five-hour']);
});

test('no room: off, error, missing weekly reset, any window at 98%, bad numbers', () => {
  const ok = () => account('x', 20, '2026-01-08T00:00:00Z', { used: 0, resetsAt: '2026-01-06T15:00:00Z' });
  equal(hasRoom(ok(), now), true);
  equal(hasRoom({ ...ok(), on: false }, now), false);
  equal(hasRoom({ ...ok(), error: 'quota unavailable' }, now), false);
  equal(hasRoom({ ...ok(), weekly: { used: 20, resetsAt: 'soon' } }, now), false);
  equal(hasRoom({ ...ok(), weekly: { used: 98, resetsAt: '2026-01-08T00:00:00Z' } }, now), false);
  equal(hasRoom({ ...ok(), fiveHour: { used: 98, resetsAt: '2026-01-06T15:00:00Z' } }, now), false);
  equal(hasRoom({ ...ok(), other: [{ used: 99 }] }, now), false);
  equal(hasRoom({ ...ok(), fiveHour: { used: null, resetsAt: '2026-01-06T15:00:00Z' } }, now), false);
});

test('a window whose reset time has passed counts as renewed', () => {
  const stale = account('x', 100, '2026-01-06T11:00:00Z', { used: 100, resetsAt: '2026-01-06T10:00:00Z' });
  equal(hasRoom(stale, now), true);
  equal(weeklyResetAt(stale, now), Date.parse('2026-01-13T11:00:00Z'));
});

test('exhausted accounts keep the same ordering among themselves', () => {
  deepEqual(orderAccounts([
    account('late', 100, '2026-01-09T00:00:00Z'),
    account('soon', 100, '2026-01-07T00:00:00Z'),
  ], now), ['soon', 'late']);
});

test('decide: unchanged, hold, out-of-room bypass, and rule changes', () => {
  const accounts = [
    account('weekly', 10, '2026-01-10T00:00:00Z'),
    account('five-hour', 30, '2026-01-12T00:00:00Z', { used: 40, resetsAt: '2026-01-06T14:00:00Z' }),
  ];
  equal(decide({ accounts, currentOrder: ['five-hour', 'weekly'], now }).reason, 'unchanged');
  const recent = new Date(now - 5 * 60_000).toISOString();
  deepEqual(decide({ accounts, currentOrder: ['weekly', 'five-hour'], lastChangeAt: recent, now }), { order: ['five-hour', 'weekly'], change: false, reason: 'hold' });
  const old = new Date(now - 15 * 60_000).toISOString();
  deepEqual(decide({ accounts, currentOrder: ['weekly', 'five-hour'], lastChangeAt: old, now }), { order: ['five-hour', 'weekly'], change: true, reason: 'rule' });
  const full = [{ ...accounts[0], weekly: { used: 99, resetsAt: '2026-01-10T00:00:00Z' } }, accounts[1]];
  deepEqual(decide({ accounts: full, currentOrder: ['weekly', 'five-hour'], lastChangeAt: recent, now }), { order: ['five-hour', 'weekly'], change: true, reason: 'first-account-out-of-room' });
});

test('accounts from two providers sort by the same rule: soonest weekly reset among those with room', () => {
  const five = used => ({ used, resetsAt: '2026-01-06T15:00:00Z' });
  deepEqual(orderAccounts([
    account('a-personal', 20, '2026-01-09T00:00:00Z', five(10), { provider: 'a' }),
    account('a-work', 50, '2026-01-07T00:00:00Z', five(99), { provider: 'a' }),
    account('b-personal', 10, '2026-01-11T00:00:00Z', five(0), { provider: 'b' }),
    account('b-work', 70, '2026-01-08T00:00:00Z', five(30), { provider: 'b' }),
  ], now), ['b-work', 'a-personal', 'b-personal', 'a-work']);
});

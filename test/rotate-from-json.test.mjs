import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAccounts } from '../examples/rotate-from-json.mjs';

const script = fileURLToPath(new URL('../examples/rotate-from-json.mjs', import.meta.url));

// A snapshot in the router's current order. Resets are far in the future so "now" doesn't matter.
const snapshot = [
  { id: 'weekly-only', weekly: { used: 40, resetsAt: '2099-01-07T22:00:00Z' }, fiveHour: null },
  { id: 'work', weekly: { used: 50, resetsAt: '2099-01-09T07:00:00Z' }, fiveHour: { used: 20, resetsAt: '2099-01-01T05:00:00Z' } },
  { id: 'paused', on: false, weekly: { used: 0, resetsAt: '2099-01-08T00:00:00Z' }, fiveHour: null },
];
const ruleOrder = ['work', 'weekly-only', 'paused'];

function setup(accounts = snapshot) {
  const home = mkdtempSync(join(tmpdir(), 'rotation-json-'));
  writeFileSync(join(home, 'accounts.json'), JSON.stringify(accounts));
  // An installer that waits $INSTALL_SLEEP_MS, records what it was given and exits with $INSTALL_EXIT.
  const installer = join(home, 'install');
  writeFileSync(installer, `#!${process.execPath}\nconst fs = require('node:fs');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.INSTALL_SLEEP_MS || 0));\nfs.appendFileSync(${JSON.stringify(join(home, 'installed.jsonl'))}, fs.readFileSync(0, 'utf8'));\nprocess.exit(Number(process.env.INSTALL_EXIT || 0));\n`);
  chmodSync(installer, 0o755);
  const env = { ...process.env, ROTATION_DIR: join(home, 'state') };
  const installed = () => existsSync(join(home, 'installed.jsonl'))
    ? readFileSync(join(home, 'installed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { home, env, installer, installed, file: join(home, 'accounts.json') };
}
const runScript = (args, env, input) => new Promise(resolve => {
  const child = execFile(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) =>
    resolve({ code: error ? error.code : 0, out: stdout.trim() ? JSON.parse(stdout) : null, stderr }));
  if (input !== undefined) child.stdin.end(input);
});

test('dry run prints the rule order and writes no state', async () => {
  const { home, env, file } = setup();
  const { code, out } = await runScript([file], env);
  equal(code, 0);
  deepEqual(out.order, ruleOrder);
  equal(out.change, true);
  equal(out.reason, 'rule');
  equal(out.applied, false);
  equal(existsSync(join(home, 'state', 'state.json')), false);
});

test('reads the snapshot from stdin with -', async () => {
  const { env } = setup();
  const { code, out } = await runScript(['-'], env, JSON.stringify(snapshot));
  equal(code, 0);
  deepEqual(out.order, ruleOrder);
});

test('--apply hands the new order to the installer, records the change, and the next snapshot is unchanged', async () => {
  const { home, env, installer, installed, file } = setup();
  const first = await runScript([file, '--apply', installer], env);
  equal(first.code, 0, JSON.stringify(first.out));
  equal(first.out.applied, true);
  deepEqual(installed(), [ruleOrder]);
  const state = JSON.parse(readFileSync(join(home, 'state', 'state.json'), 'utf8'));
  equal(state.lastChangeAt, first.out.time);
  deepEqual(state.order, ruleOrder);
  // The router now reports the new order.
  writeFileSync(file, JSON.stringify(ruleOrder.map(id => snapshot.find(a => a.id === id))));
  const second = await runScript([file, '--apply', installer], env);
  equal(second.out.reason, 'unchanged');
  equal(installed().length, 1, 'installer not called again');
});

test('a recent change is held while the first account has room; running out switches at once', async () => {
  const { env, installer, installed, file } = setup();
  await runScript([file, '--apply', installer], env);
  // Router in the new order, but now weekly-only resets sooner than work's week and both lose their 5-hour edge.
  const shifted = [
    { ...snapshot[1], fiveHour: null },
    { ...snapshot[0], weekly: { used: 40, resetsAt: '2099-01-02T00:00:00Z' } },
    snapshot[2],
  ];
  writeFileSync(file, JSON.stringify(shifted));
  const held = await runScript([file, '--apply', installer], env);
  equal(held.out.reason, 'hold');
  equal(held.out.change, false);
  equal(installed().length, 1);
  shifted[0] = { ...shifted[0], weekly: { used: 99, resetsAt: '2099-01-09T07:00:00Z' } };
  writeFileSync(file, JSON.stringify(shifted));
  const out = await runScript([file, '--apply', installer], env);
  equal(out.out.reason, 'first-account-out-of-room');
  // Accounts without room go last, soonest weekly reset first among them.
  deepEqual(installed().at(-1), ['weekly-only', 'paused', 'work']);
});

test('a failing installer is reported and no change time is recorded', async () => {
  const { home, env, installer, file } = setup();
  const { code, out } = await runScript([file, '--apply', installer], { ...env, INSTALL_EXIT: '3' });
  equal(code, 1);
  equal(out.reason, 'error');
  equal(out.applied, false);
  equal(existsSync(join(home, 'state', 'state.json')), false);
});

test('a state directory that cannot be written stops the run before the installer', async () => {
  const { home, env, installer, installed, file } = setup();
  const { code, out } = await runScript([file, '--apply', installer], { ...env, ROTATION_DIR: join(home, 'accounts.json', 'state') });
  equal(code, 1);
  equal(out.reason, 'error');
  equal(out.applied, false);
  deepEqual(installed(), []);
});

test('two overlapping --apply runs: one installs, the other finds the lock taken', async () => {
  const { env, installer, installed, file } = setup();
  const slow = { ...env, INSTALL_SLEEP_MS: '1500' };
  const runs = await Promise.all([runScript([file, '--apply', installer], slow), runScript([file, '--apply', installer], slow)]);
  deepEqual(runs.map(r => r.code).sort(), [0, 1]);
  ok(runs.find(r => r.code === 1).out.error.includes('Another run holds the lock'));
  deepEqual(installed(), [ruleOrder]);
});

test('state goes to ~/.local/state/optimal-subs-router by default', async () => {
  const { home, installer, file } = setup();
  const env = { ...process.env, HOME: home };
  delete env.ROTATION_DIR;
  equal((await runScript([file, '--apply', installer], env)).code, 0);
  ok(existsSync(join(home, '.local/state/optimal-subs-router/state.json')));
});

test('bad snapshots and arguments are refused with exit code 2', async () => {
  throws(() => parseAccounts('{}'), /non-empty JSON array/);
  throws(() => parseAccounts('[]'), /non-empty JSON array/);
  throws(() => parseAccounts('[{"weekly":{}}]'), /needs an id/);
  throws(() => parseAccounts('[{"id":"a"},{"id":"a"}]'), /Duplicate account id: a/);
  const { env, home } = setup();
  writeFileSync(join(home, 'bad.json'), '[{"id":"a"},{"id":"a"}]');
  const bad = await runScript([join(home, 'bad.json')], env);
  equal(bad.code, 2);
  ok(bad.stderr.includes('Duplicate account id'));
  equal((await runScript([], env)).code, 2);
  equal((await runScript([join(home, 'accounts.json'), '--apply'], env)).code, 2);
});

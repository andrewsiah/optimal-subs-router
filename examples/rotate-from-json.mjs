// Run the rotation rule once on a JSON snapshot of your subscriptions.
//   node examples/rotate-from-json.mjs accounts.json                    print the decision, change nothing
//   my-router quota --json | node examples/rotate-from-json.mjs -       read the snapshot from stdin
//   node examples/rotate-from-json.mjs accounts.json --apply ./install  also install a new order
// Run it every minute from a systemd timer, launchd or cron. It makes no model calls.
//
// Snapshot: a JSON array of accounts in the order your router uses them now, each in
//   the shape src/rotation.mjs expects: { id, on?, error?, weekly: { used, resetsAt },
//   fiveHour: { used, resetsAt } | null, other?: [{ used }] }.
// --apply CMD: when the order should change, runs CMD (no shell) with the new order as a
//   JSON array on stdin. CMD installs it in your router and exits 0. Only then is the
//   change time recorded, so the 15-minute hold works across runs. One --apply run at a
//   time per state directory: a second one finds the lock taken and exits with an error.
// Files: $ROTATION_DIR (default ~/.local/state/optimal-subs-router)/state.json.
// Output: one JSON line per run: { time, order, change, reason, applied }.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../src/rotation.mjs';

export const defaultStateDir = () => join(homedir(), '.local/state/optimal-subs-router');

// Parse and check a snapshot. Throws with a readable message on anything the rule can't use.
export function parseAccounts(text) {
  const accounts = JSON.parse(text);
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('The snapshot must be a non-empty JSON array of accounts');
  const seen = new Set();
  for (const a of accounts) {
    if (!a || (typeof a.id !== 'string' && typeof a.id !== 'number')) throw new Error('Every account needs an id');
    if (seen.has(a.id)) throw new Error(`Duplicate account id: ${a.id}`);
    seen.add(a.id);
  }
  return accounts;
}

const readState = dir => {
  try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
};

// The --apply lock: a listening loopback port derived from the state directory. The
// operating system frees it when a run dies, so it can't go stale.
export const lockPort = dir => 20_000 + createHash('sha256').update(resolve(dir)).digest().readUInt32BE(0) % 10_000;
export const acquireLock = dir => new Promise((resolveLock, reject) => {
  const server = createServer(), port = lockPort(dir);
  server.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error(`Another run holds the lock for ${dir} (127.0.0.1:${port})`) : error));
  server.listen(port, '127.0.0.1', () => resolveLock(server));
});

// Call with the lock held when apply is set, so read, decide, install and save happen as one step.
export function run({ accounts, dir, apply, now = Date.now() }) {
  const state = readState(dir);
  const time = new Date(now).toISOString();
  const decision = { time, ...decide({ accounts, currentOrder: accounts.map(a => a.id), lastChangeAt: state.lastChangeAt, now }), applied: false };
  if (!decision.change || !apply) return decision;
  // Write the new state before touching the router, so a state directory we can't write stops the run first.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'state.json'), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastChangeAt: time, order: decision.order }) + '\n', { mode: 0o600 });
  try { execFileSync(apply, [], { input: JSON.stringify(decision.order) + '\n', stdio: ['pipe', 'ignore', 'inherit'], timeout: 30_000 }); }
  catch (error) { rmSync(tmp, { force: true }); throw error; }
  try { renameSync(tmp, file); }
  catch (error) { throw Object.assign(new Error(`New order installed, but its change time was not saved: ${error.message}`), { applied: true }); }
  return { ...decision, applied: true };
}

async function main(argv) {
  const [source] = argv;
  const applyAt = argv.indexOf('--apply');
  const apply = applyAt >= 0 ? argv[applyAt + 1] : null;
  if (!source || source.startsWith('--') || (applyAt >= 0 && !apply)) {
    console.error('Usage: node examples/rotate-from-json.mjs ACCOUNTS.json|- [--apply COMMAND]');
    return 2;
  }
  let accounts;
  try { accounts = parseAccounts(readFileSync(source === '-' ? 0 : source, 'utf8')); }
  catch (error) { console.error(error.message); return 2; }
  const dir = process.env.ROTATION_DIR || defaultStateDir();
  let lock = null;
  try {
    if (apply) lock = await acquireLock(dir);
    console.log(JSON.stringify(run({ accounts, dir, apply })));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ time: new Date().toISOString(), reason: 'error', error: error.message, applied: error.applied === true }));
    return 1;
  } finally {
    lock?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));

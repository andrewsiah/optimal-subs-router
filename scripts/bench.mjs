// Synthetic benchmark: the rule against round-robin, a random order and a fixed order
// on generated scenarios (src/synthetic.mjs). No real logs.
//   npm run bench                         full run, writes results/synthetic-benchmark.json
//   node scripts/bench.mjs --seeds 2 --out /tmp/x.json --workers 2
// Results depend only on the seeds, not on worker count or timing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { seededRandom, simulate } from '../src/simulate.mjs';
import { ACCOUNT_SETS, DEMAND_MODELS, MEASURED_WEEKS, PLANS, WARMUP_WEEKS, WORK_PER_UNIT, makeScenario } from '../src/synthetic.mjs';

export const INTENSITIES = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];
export const POLICIES = {
  'rule': '5-hour accounts with room first, then the soonest weekly reset (src/rotation.mjs, 15-minute hold)',
  'round-robin': 'Per-request rotation over the accounts with room; a full account drops out and the others split its share',
  'random': 'A fresh random order every minute, failing over to the next account with room',
  'fixed-order': 'One order per seed, drawn at random, failing over to the next account with room',
};
const steady = { start: 'spent', resets: 'random', warmupWeeks: WARMUP_WEEKS, measuredWeeks: MEASURED_WEEKS };
export const CELLS = [
  // Where the rule matters most among the patterns searched: busy weeks with a quiet week,
  // weekly resets spread evenly. The same pattern with random resets follows it.
  { name: 'two-providers/busy-weeks-then-quiet/even-resets', set: 'two-providers', model: 'busy-weeks-then-quiet', ...steady, resets: 'even' },
  ...Object.keys(DEMAND_MODELS).map(model => ({ name: `two-providers/${model}`, set: 'two-providers', model, ...steady })),
  // The first two weeks after a break: every account starts unused.
  { name: 'two-providers/keeps-blasting/after-a-break', set: 'two-providers', model: 'keeps-blasting', start: 'full', resets: 'random', warmupWeeks: 0, measuredWeeks: 2 },
  { name: 'three-plan-sizes/keeps-blasting', set: 'three-plan-sizes', model: 'keeps-blasting', ...steady },
];

// One seed of one cell at one intensity, every policy on the same scenario.
export function runJob({ cell, intensity, seed }) {
  const { set, model, start, resets, warmupWeeks, measuredWeeks } = cell;
  const scenario = makeScenario({ set, model, intensity, seed, start, resets, warmupWeeks, measuredWeeks });
  const ids = scenario.accounts.map(a => a.id), shuffle = seededRandom(seed * 104_729 + 3);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(shuffle() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const out = {};
  for (const name of Object.keys(POLICIES)) {
    const policy = name === 'fixed-order' ? { fixed: ids } : name;
    const r = simulate({ accounts: scenario.accounts, demand: scenario.demand, start: scenario.start, end: scenario.end, warmupMs: scenario.warmupMs, startUsedPct: scenario.startUsedPct, policy, seed });
    out[name] = {
      servedPct: 100 * r.servedShare,
      allOutHoursPerWeek: r.allOutHoursPerWeek,
      unservedHoursPerWeek: r.unservedHoursPerWeek,
      wastedPct: 100 * r.expiredWorkPerWeek / scenario.capacityPerWeek,
    };
  }
  return out;
}

const round = x => Math.round(x * 1000) / 1000;
function stats(xs) {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean: round(mean), sd: round(sd), min: round(Math.min(...xs)), max: round(Math.max(...xs)) };
}
const TIE_PTS = 0.1; // Differences under 0.1 points of demand served count as a tie.

// runs: one runJob() result per seed, in seed order.
export function summarize(runs) {
  const policies = Object.fromEntries(Object.keys(POLICIES).map(p => [p, Object.fromEntries(
    Object.keys(runs[0][p]).map(metric => [metric, stats(runs.map(r => r[p][metric]))]))]));
  const diff = runs.map(r => r.rule.servedPct - r['round-robin'].servedPct);
  return { policies, ruleMinusRoundRobinServedPts: { ...stats(diff),
    wins: diff.filter(d => d >= TIE_PTS).length, ties: diff.filter(d => Math.abs(d) < TIE_PTS).length, losses: diff.filter(d => d <= -TIE_PTS).length } };
}

function parseArgs(argv) {
  const get = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; };
  const seeds = Number(get('--seeds', 20)), workers = Number(get('--workers', Math.max(1, Math.min(4, availableParallelism() - 2))));
  if (!Number.isInteger(seeds) || seeds < 1 || !Number.isInteger(workers) || workers < 1) throw new Error('--seeds and --workers must be whole numbers of at least 1');
  return { seeds, workers, out: get('--out', fileURLToPath(new URL('../results/synthetic-benchmark.json', import.meta.url))) };
}

async function main() {
  const { seeds, workers, out } = parseArgs(process.argv.slice(2));
  const jobs = [];
  CELLS.forEach((cell, c) => INTENSITIES.forEach((intensity, i) => { for (let seed = 1; seed <= seeds; seed++) jobs.push({ c, i, seed }); }));
  const results = new Map();
  let next = 0, done = 0;
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, () => new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url));
    const send = () => {
      if (next >= jobs.length) { worker.terminate().then(resolve); return; }
      const job = jobs[next++];
      worker.once('message', result => {
        results.set(`${job.c}/${job.i}/${job.seed}`, result);
        if (++done % 40 === 0 || done === jobs.length) console.error(`${done}/${jobs.length} runs, ${Math.round((Date.now() - startedAt) / 1000)} s`);
        send();
      });
      worker.postMessage({ cell: CELLS[job.c], intensity: INTENSITIES[job.i], seed: job.seed });
    };
    worker.on('error', reject);
    send();
  })));

  const report = {
    about: 'Synthetic benchmark of subscription-rotation policies. Simulated; plan limits are made-up tiers in relative units.',
    assumptions: [
      '1 plan unit is one weekly allowance of a small personal plan; the other plan tiers are made-up multiples of it.',
      `Each seed jitters each plan limit by up to ±25% and places the weekly resets: at random minutes of the week (resets: random), or evenly spaced from a random start in a random account order (resets: even).`,
      'Work is interchangeable across providers: an agent task can run on either.',
      'Demand intensity is demand per measured week divided by the accounts\' combined weekly allowance; it is exact in every seed.',
      'Steady-state cells start with every weekly allowance spent and measure after the warm-up. The after-a-break cell starts with every account unused and measures from the start.',
    ],
    workPerUnit: WORK_PER_UNIT, plans: PLANS, accountSets: ACCOUNT_SETS, demandModels: DEMAND_MODELS, policies: POLICIES,
    seeds, intensities: INTENSITIES, tiePts: TIE_PTS,
    cells: CELLS.map((cell, c) => ({ ...cell, points: INTENSITIES.map((intensity, i) => ({ intensity,
      ...summarize(Array.from({ length: seeds }, (_, s) => results.get(`${c}/${i}/${s + 1}`))) })) })),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  for (const cell of report.cells) {
    console.log(`\n${cell.name} (warm-up ${cell.warmupWeeks} wk, measured ${cell.measuredWeeks} wk), % of demand served, mean over ${seeds} seeds`);
    console.log('intensity  ' + Object.keys(POLICIES).map(p => p.padStart(12)).join('') + '   rule-RR (min..max)  W/T/L');
    for (const p of cell.points) {
      const d = p.ruleMinusRoundRobinServedPts;
      console.log(`${String(p.intensity).padEnd(9)}  ${Object.keys(POLICIES).map(k => p.policies[k].servedPct.mean.toFixed(2).padStart(12)).join('')}   ${d.mean.toFixed(2).padStart(6)} (${d.min.toFixed(2)}..${d.max.toFixed(2)})  ${d.wins}/${d.ties}/${d.losses}`);
    }
  }
  console.error(`wrote ${out}`);
}

if (!isMainThread) parentPort.on('message', job => parentPort.postMessage(runJob(job)));
else if (process.argv[1] === fileURLToPath(import.meta.url)) await main();


// Draw docs/served.png from results/synthetic-benchmark.json: % of demand served against
// demand intensity, one line per policy, for the pattern where the rule matters most and
// for steady nonstop demand. SVG rendered to PNG by headless Chrome.
//   npm run chart        (CHROME=path to Chrome, INTER_FONT=path to an Inter font file; both optional)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = JSON.parse(readFileSync(process.argv[2] || join(root, 'results/synthetic-benchmark.json'), 'utf8'));
const out = process.argv[3] || join(root, 'docs/served.png');

const C = { bg: '#FAF8F4', ink: '#1E1D1B', grey: '#8F8A80', light: '#BDB7AC', faint: '#E6E1D8', accent: '#D4572A' };
const SERIES = [
  { policy: 'rule', label: 'Our Rule', color: C.accent, width: 3.5 },
  { policy: 'round-robin', label: 'Round-Robin', color: C.ink, width: 2 },
  { policy: 'random', label: 'Random', color: C.grey, width: 2, dash: '6 5' },
  { policy: 'fixed-order', label: 'Fixed Order', color: C.light, width: 2 },
];
const PANELS = [
  { cell: 'two-providers/busy-weeks-then-quiet/even-resets', title: 'Best Case: Three Busy Weeks, Then A Quiet One' },
  { cell: 'two-providers/keeps-blasting', title: 'Steady Nonstop Use: Rule, Round-Robin, Random Tie' },
];
const W = 1200, H = 700, YMIN = 40, YMAX = 100;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, s, a = {}) => `<text x="${x}" y="${y}" ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}>${esc(s)}</text>`;

function panel(spec, box) {
  const cell = results.cells.find(c => c.name === spec.cell);
  if (!cell) throw new Error(`No cell ${spec.cell} in results`);
  const pts = cell.points, xs = pts.map(p => p.intensity), lx = Math.log2;
  const X = v => box.x + (lx(v) - lx(xs[0])) / (lx(xs.at(-1)) - lx(xs[0])) * box.w;
  const Y = v => box.y + box.h - (v - YMIN) / (YMAX - YMIN) * box.h;
  const value = (p, policy) => p.policies[policy].servedPct.mean;
  let svg = text(box.x, box.y - 34, spec.title, { 'font-size': 19, 'font-weight': 650, fill: C.ink });
  // Axes: y ticks every 20 points, x ticks at each intensity, a faint marker where demand equals the allowance.
  for (let v = YMIN; v <= YMAX; v += 20) svg += text(box.x - 12, Y(v) + 5, `${v}%`, { 'font-size': 14, fill: C.grey, 'text-anchor': 'end' });
  svg += `<line x1="${box.x}" x2="${box.x + box.w}" y1="${Y(YMIN)}" y2="${Y(YMIN)}" stroke="${C.faint}" stroke-width="1.5"/>`;
  svg += `<line x1="${X(1)}" x2="${X(1)}" y1="${box.y}" y2="${Y(YMIN)}" stroke="${C.faint}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  svg += text(X(1) + 6, box.y + 4, 'Demand = Allowance', { 'font-size': 13, fill: C.grey });
  for (const v of xs.filter(v => [0.5, 0.75, 1, 1.25, 1.5, 2].includes(v))) svg += text(X(v), Y(YMIN) + 24, `${v}×`, { 'font-size': 14, fill: C.grey, 'text-anchor': 'middle' });
  for (const s of [...SERIES].reverse()) {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.intensity).toFixed(1)},${Y(value(p, s.policy)).toFixed(1)}`).join(' ');
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
  }
  // Labels: series that agree within 0.15 points everywhere share one leader, one name per
  // line. Labels sit in a column right of the plot, in the order the lines take where they
  // differ most, with short leaders to each line's last point.
  const spread = p => Math.max(...SERIES.map(s => value(p, s.policy))) - Math.min(...SERIES.map(s => value(p, s.policy)));
  const widest = pts.reduce((a, b) => (spread(b) > spread(a) ? b : a));
  const groups = [];
  for (const s of [...SERIES].sort((a, b) => value(widest, b.policy) - value(widest, a.policy))) {
    const same = groups.find(g => pts.every(p => Math.abs(value(p, g[0].policy) - value(p, s.policy)) < 0.15));
    if (same) same.push(s); else groups.push([s]);
  }
  for (const g of groups) g.sort((a, b) => SERIES.indexOf(a) - SERIES.indexOf(b));
  const end = pts.at(-1), labelX = box.x + box.w + 22, LINE = 19, GAP = 9;
  const height = groups.reduce((h, g) => h + g.length * LINE + GAP, -GAP);
  let y = Math.min(Y(value(end, groups[0][0].policy)) - height / 2 + LINE / 2, Y(YMIN) - height + LINE);
  for (const g of groups) {
    svg += `<line x1="${X(end.intensity) + 5}" y1="${Y(value(end, g[0].policy))}" x2="${labelX - 5}" y2="${y - 5}" stroke="${C.faint}" stroke-width="1"/>`;
    for (const s of g) {
      svg += text(labelX, y, s.label, { 'font-size': 15, 'font-weight': s.policy === 'rule' ? 650 : 500, fill: s.color === C.light ? C.grey : s.color });
      y += LINE;
    }
    y += GAP;
  }
  // Mark the largest gap between the rule and round-robin, right of the rule's point (the
  // lines fall to the right, so the space there is empty).
  const gap = pts.reduce((a, b) => (b.ruleMinusRoundRobinServedPts.mean > a.ruleMinusRoundRobinServedPts.mean ? b : a));
  const g = gap.ruleMinusRoundRobinServedPts.mean;
  if (g >= 0.5) {
    svg += `<circle cx="${X(gap.intensity)}" cy="${Y(value(gap, 'rule'))}" r="5" fill="${C.accent}"/>`;
    svg += text(X(gap.intensity) + 14, Y(value(gap, 'rule')) + 2, `+${g.toFixed(1)} Pts Over Round-Robin`, { 'font-size': 15, 'font-weight': 650, fill: C.accent });
  }
  svg += text(box.x, Y(YMIN) + 62, 'Demand ÷ Combined Weekly Allowance', { 'font-size': 14, 'font-weight': 600, fill: C.grey });
  return svg;
}

const boxes = [{ x: 90, y: 210, w: 330, h: 380 }, { x: 680, y: 210, w: 330, h: 380 }];
// The showcase pattern's largest gap with random reset times, for the subtitle.
const randomResetGap = Math.max(...results.cells.find(c => c.name === 'two-providers/busy-weeks-then-quiet').points.map(p => p.ruleMinusRoundRobinServedPts.mean));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${text(90, 64, 'Spending The Soonest-Expiring Allowance First Pays Off When Usage Has Quiet Spells', { 'font-size': 26, 'font-weight': 700, fill: C.ink })}
${text(90, 98, `Share of demand served, simulated. Four subscriptions: a personal and a work plan at two providers, staggered weekly resets. Mean of ${results.seeds} seeds.`, { 'font-size': 16, fill: C.grey })}
${text(90, 124, `Left: best case found, resets spread evenly (one every 42 hours). With random reset times: +${randomResetGap.toFixed(1)} pts.`, { 'font-size': 16, fill: C.grey })}
${PANELS.map((p, i) => panel(p, boxes[i])).join('\n')}
</svg>`;

const font = process.env.INTER_FONT;
const face = font && existsSync(font) ? `@font-face{font-family:Inter;src:url(${pathToFileURL(font).href});font-weight:100 900}` : '';
const dir = mkdtempSync(join(tmpdir(), 'rotation-chart-'));
try {
  writeFileSync(join(dir, 'chart.html'), `<!doctype html><meta charset="utf-8"><style>${face}html,body{margin:0;background:${C.bg}}svg{display:block;font-family:Inter,system-ui,sans-serif;font-feature-settings:"tnum" 1}</style>${svg}`);
  const chrome = process.env.CHROME || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/bin/chromium'].find(existsSync);
  if (!chrome) throw new Error('Set CHROME to a Chrome or Chromium binary');
  execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--user-data-dir=${join(dir, 'profile')}`,
    `--window-size=${W},${H}`, '--virtual-time-budget=3000', `--screenshot=${out}`, pathToFileURL(join(dir, 'chart.html')).href], { stdio: 'ignore', timeout: 60_000 });
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`wrote ${out}`);

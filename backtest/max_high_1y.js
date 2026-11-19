#!/usr/bin/env node
/* Bullish Divergence · highest price within 1 year of each signal
 *
 *   node max_high_1y.js <dataDir> <meta.json> [out.csv]
 *
 * Entry = the weekly close of the week the divergence is confirmed (the week the indicator draws it).
 * Highest price = the highest weekly high in the 52 weeks after that week. Reported as % above the entry.
 * Only signals with a full 52 weeks of data after them are counted.
 * Baseline = the same measurement from every week of the same stocks (from the week RSI exists).
 * Uses closed Mon–Fri weekly bars (scan_now.js loader) and the indicator's exact rules (div_lab.js).
 */
const fs = require('fs');
const path = require('path');
const { run } = require('./div_lab.js');
const { loadClosed } = require('./scan_now.js');

const P = { rsiLen: 14, startMax: 31, redLvl: 33, darkLvl: 35, useClose: false, lbL: 5, lbR: 2, pWin: 1, maxAge: 52 };
const NAMES = ['', 'Yellow', 'Orange', 'Light red', 'Red', 'Dark red'];
const H = 52;
const day = t => new Date(t * 1000).toISOString().slice(0, 10);
const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
const med = v => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctAt = (v, x) => (100 * v.filter(y => y >= x).length) / v.length;

const [dir, metaPath, outCsv] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const sig = [], base = [], baseSince2010 = [];
const t2010 = Date.UTC(2010, 0, 1) / 1000;
for (const m of meta) {
  const sym = m.sym.replace('.', '-');
  if (!fs.existsSync(path.join(dir, sym + '.json'))) continue;
  const bars = loadClosed(dir, sym);
  if (bars.length < 30) continue;
  const { ev, rsi } = run(bars, P);
  // highest high over the next 52 weeks, for every week (sliding window max from the right)
  const n = bars.length;
  const fwdMax = new Array(n).fill(NaN), fwdWk = new Array(n).fill(-1);
  for (let i = 0; i + H < n; i++) {
    let mx = -Infinity, at = -1;
    for (let k = i + 1; k <= i + H; k++) if (bars[k].h > mx) { mx = bars[k].h; at = k; }
    fwdMax[i] = mx; fwdWk[i] = at - i;
  }
  for (let i = 0; i + H < n; i++) if (rsi[i] >= 0) { const g = (fwdMax[i] / bars[i].c - 1) * 100; base.push(g); if (bars[i].t >= t2010) baseSince2010.push(g); }
  for (const e of ev) {
    if (e.type !== 'div' || !(e.conf + H < n)) continue;
    const c0 = bars[e.conf].c;
    sig.push({ sym, name: m.name, sector: m.sector, tier: e.tier, k: e.k, week: day(bars[e.conf].t), t: bars[e.conf].t, entry: c0, high: fwdMax[e.conf],
               gain: (fwdMax[e.conf] / c0 - 1) * 100, weeksToHigh: fwdWk[e.conf], close1y: bars[e.conf + H].c, chg1y: (bars[e.conf + H].c / c0 - 1) * 100 });
  }
}

const row = (lab, v, extra = '') => {
  const g = v.map(x => (typeof x === 'number' ? x : x.gain));
  console.log(`${lab.padEnd(24)} n ${String(g.length).padStart(5)}  mean ${mean(g).toFixed(1).padStart(6)}%  median ${med(g).toFixed(1).padStart(6)}%  ≥+10% ${pctAt(g, 10).toFixed(0).padStart(3)}%  ≥+20% ${pctAt(g, 20).toFixed(0).padStart(3)}%  ≥+50% ${pctAt(g, 50).toFixed(0).padStart(3)}%${extra}`);
};
console.log(`Highest price within 52 weeks after the signal week's close (% above that close)\n`);
row('All signals', sig, `  median weeks to the high ${med(sig.map(s => s.weeksToHigh))}  · median price 1y later ${med(sig.map(s => s.chg1y)).toFixed(1)}%`);
for (let t = 1; t <= 5; t++) row(NAMES[t], sig.filter(s => s.tier === t));
row('Baseline (any week)', base);
const s10 = sig.filter(s => s.t >= t2010);
row('Signals since 2010', s10);
row('Baseline since 2010', baseSince2010);
for (let t = 1; t <= 5; t++) row('  ' + NAMES[t] + ' since 2010', s10.filter(s => s.tier === t));
const g = sig.map(s => s.gain).sort((a, b) => a - b);
console.log(`\nmean without the top/bottom 5%: ${mean(g.slice(Math.floor(g.length * 0.05), Math.ceil(g.length * 0.95))).toFixed(1)}%  · stocks with signals: ${new Set(sig.map(s => s.sym)).size}  · signals ${day(Math.min(...sig.map(s => s.t)))} → ${day(Math.max(...sig.map(s => s.t)))}`);
console.log('biggest:', [...sig].sort((a, b) => b.gain - a.gain).slice(0, 5).map(s => `${s.sym} ${s.week} +${s.gain.toFixed(0)}%`).join(' | '));
console.log('smallest:', [...sig].sort((a, b) => a.gain - b.gain).slice(0, 5).map(s => `${s.sym} ${s.week} ${s.gain >= 0 ? '+' : ''}${s.gain.toFixed(1)}%`).join(' | '));

if (outCsv) {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  fs.writeFileSync(outCsv, 'ticker,name,sector,colour,divergence_no,signal_week,entry_close,highest_high_1y,max_gain_pct,weeks_to_high,close_1y_later,change_1y_pct\n' +
    sig.sort((a, b) => a.t - b.t).map(s => [s.sym, q(s.name), q(s.sector), NAMES[s.tier], s.k, s.week, s.entry.toFixed(2), s.high.toFixed(2), s.gain.toFixed(1), s.weeksToHigh, s.close1y.toFixed(2), s.chg1y.toFixed(1)].join(',')).join('\n') + '\n');
  console.log('wrote', outCsv);
}

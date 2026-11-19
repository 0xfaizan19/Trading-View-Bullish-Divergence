#!/usr/bin/env node
/* Bullish Divergence · forward check: price 6 months (26 weeks) and 1 year (52 weeks) after every signal.
 *
 *   node forward_check.js <dataDir> <out.csv> [SYMBOL ...]
 *
 * Uses div_lab.js (the indicator's exact logic) on Yahoo weekly bars. A signal "fires" at the close of the week
 * the divergence is confirmed (2 weekly closes after the low), so that close is the entry price. The baseline is
 * the same 26/52-week change measured from EVERY week of the same stocks' history (from the week RSI exists).
 */
const fs = require('fs');
const path = require('path');
const { run, load } = require('./div_lab.js');

const NAMES = ['', 'Yellow', 'Orange', 'Light red', 'Red', 'Dark red'];
const day = t => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (a, b) => (b / a - 1) * 100;
const med = v => { if (!v.length) return NaN; const s = [...v].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = v => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const up = v => (v.length ? (100 * v.filter(x => x > 0).length) / v.length : NaN);

const [dir, out, ...rest] = process.argv.slice(2);
const syms = rest.length ? rest : fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'top50.json').map(f => f.slice(0, -5));
const rows = [], base26 = [], base52 = [];
for (const s of syms) {
  const bars = load(dir, s);
  const { ev, rsi } = run(bars);
  for (let i = 0; i < bars.length; i++) {
    if (!(rsi[i] >= 0)) continue;
    if (i + 26 < bars.length) base26.push(pct(bars[i].c, bars[i + 26].c));
    if (i + 52 < bars.length) base52.push(pct(bars[i].c, bars[i + 52].c));
  }
  for (const e of ev) {
    if (e.type !== 'div') continue;
    const c0 = bars[e.conf].c;
    const c26 = e.conf + 26 < bars.length ? bars[e.conf + 26].c : null;
    const c52 = e.conf + 52 < bars.length ? bars[e.conf + 52].c : null;
    rows.push({ sym: s, colour: NAMES[e.tier], tier: e.tier, k: e.k, fired: day(bars[e.conf].t), low: day(bars[e.pbar].t), rsi: e.rsi,
                p0: c0, p26: c26, r26: c26 == null ? null : pct(c0, c26), p52: c52, r52: c52 == null ? null : pct(c0, c52) });
  }
}
rows.sort((a, b) => a.fired.localeCompare(b.fired));
fs.writeFileSync(out, 'ticker,colour,divergence_no,fired_week,price_low_week,rsi_low,price_when_fired,price_6m_later,change_6m_pct,price_1y_later,change_1y_pct\n' +
  rows.map(r => [r.sym, r.colour, r.k, r.fired, r.low, r.rsi.toFixed(1), r.p0.toFixed(2), r.p26 == null ? '' : r.p26.toFixed(2), r.r26 == null ? '' : r.r26.toFixed(1),
                 r.p52 == null ? '' : r.p52.toFixed(2), r.r52 == null ? '' : r.r52.toFixed(1)].join(',')).join('\n') + '\n');

const line = (lab, set) => {
  const a = set.map(r => r.r26).filter(x => x != null), b = set.map(r => r.r52).filter(x => x != null);
  console.log(`${lab.padEnd(26)} ${String(set.length).padStart(4)} | 6m: n ${String(a.length).padStart(3)} med ${med(a).toFixed(1).padStart(6)}% avg ${mean(a).toFixed(1).padStart(6)}% up ${up(a).toFixed(0).padStart(3)}% | 1y: n ${String(b.length).padStart(3)} med ${med(b).toFixed(1).padStart(6)}% avg ${mean(b).toFixed(1).padStart(6)}% up ${up(b).toFixed(0).padStart(3)}%`);
};
console.log(`${syms.length} stocks, ${rows.length} signals, ${new Set(rows.map(r => r.sym)).size} stocks with at least one`);
line('All signals', rows);
for (let t = 1; t <= 5; t++) line(NAMES[t], rows.filter(r => r.tier === t));
line('Since 2010', rows.filter(r => r.fired >= '2010'));
console.log(`${'Baseline (any week)'.padEnd(26)}      | 6m: n ${base26.length} med ${med(base26).toFixed(1)}% avg ${mean(base26).toFixed(1)}% up ${up(base26).toFixed(0)}% | 1y: n ${base52.length} med ${med(base52).toFixed(1)}% avg ${mean(base52).toFixed(1)}% up ${up(base52).toFixed(0)}%`);
const best = [...rows].filter(r => r.r52 != null).sort((a, b) => b.r52 - a.r52);
console.log('best 1y:', best.slice(0, 5).map(r => `${r.sym} ${r.fired} ${r.colour} ${r.r52.toFixed(0)}%`).join(' | '));
console.log('worst 1y:', best.slice(-5).map(r => `${r.sym} ${r.fired} ${r.colour} ${r.r52.toFixed(0)}%`).join(' | '));
console.log('recent (2018+):'); rows.filter(r => r.fired >= '2018').forEach(r => console.log(`  ${r.sym.padEnd(6)} ${r.fired} ${r.colour.padEnd(9)} $${r.p0.toFixed(2)} → 6m ${r.p26 == null ? 'n/a' : '$' + r.p26.toFixed(2) + ' (' + r.r26.toFixed(0) + '%)'} → 1y ${r.p52 == null ? 'n/a' : '$' + r.p52.toFixed(2) + ' (' + r.r52.toFixed(0) + '%)'}`));

#!/usr/bin/env node
/* ============================================================================
 * Bullish Divergence · Node lab (matches bullish_divergence.pine v1.0)
 * ----------------------------------------------------------------------------
 * A JavaScript copy of the indicator's logic, run on Yahoo weekly bars, so the
 * rules can be checked and tested without switching your TradingView chart.
 *
 *   node div_lab.js <dataDir> [SYMBOL ...]        list every setup + divergence
 *   node div_lab.js <dataDir> --json SYMBOL       events as JSON (to compare with TradingView)
 *   node div_lab.js <dataDir> --stats [SYMBOL ...] how price did after each colour
 *
 * Data: one Yahoo chart JSON per symbol, saved as <dataDir>/<SYMBOL>.json:
 *   curl -s -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1wk&period1=0&period2=1900000000" -o SPY.json
 * The last (unfinished) week is dropped.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const DEF = { rsiLen: 14, startMax: 31, redLvl: 33, darkLvl: 35, useClose: false, lbL: 5, lbR: 2, pWin: 1, maxAge: 52 };
const NAMES = ['', 'Yellow', 'Orange', 'Light red', 'Red', 'Dark red'];

function load(dir, sym) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, sym + '.json'), 'utf8'));
  const r = j.chart.result[0], q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.low[i] == null) continue;
    bars.push({ t: r.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  // drop the unfinished week (and any intraday row Yahoo appends after it)
  while (bars.length && Date.now() / 1000 - bars[bars.length - 1].t < 7 * 86400) bars.pop();
  return bars;
}

// TradingView ta.rsi: RMA seeded with an SMA of the first `len` changes
function rsiTV(c, len) {
  const out = new Array(c.length).fill(NaN);
  let up = NaN, dn = NaN, su = 0, sd = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1], u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (i <= len) {
      su += u; sd += d;
      if (i === len) { up = su / len; dn = sd / len; }
    } else {
      up = (u + (len - 1) * up) / len;
      dn = (d + (len - 1) * dn) / len;
    }
    if (i >= len) out[i] = dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

function tierOf(k, r, P) {
  let t = Math.min(k, 4);
  if (r > P.darkLvl) t = 5;
  else if (r >= P.redLvl) t = Math.max(t, 4);
  return t;
}

function run(bars, opt = {}) {
  const P = { ...DEF, ...opt };
  const n = bars.length, rsi = rsiTV(bars.map(b => b.c), P.rsiLen);
  const pLow = bars.map(b => (P.useClose ? b.c : b.l));
  const w = Math.min(P.pWin, P.lbR);
  const ev = [];
  let ch = [], nDiv = -1, setRsi = NaN, setBar = NaN, lastBar = NaN, lastRsi = NaN, lastPBar = NaN, lastPx = NaN, curTier = 0, setIdx = -1;
  for (let i = P.lbL + P.lbR; i < n; i++) {
    const p = i - P.lbR, pr = rsi[p];
    if (!(pr >= 0)) continue;
    let piv = true;
    for (let k = 1; k <= P.lbL && piv; k++) if (!(rsi[p - k] > pr)) piv = false;
    for (let k = 1; k <= P.lbR && piv; k++) if (!(rsi[p + k] > pr)) piv = false;
    if (!piv) continue;
    // price low within ±w weeks of the RSI low 
    let pp = Infinity, ppb = -1;
    for (let k = p - w; k <= p + w; k++) if (pLow[k] <= pp) { pp = pLow[k]; ppb = k; }

    if (nDiv >= 0 && p - setBar > P.maxAge) nDiv = -1;
    if (nDiv >= 0 && pr > setRsi && pp < lastPx) {
      // price lower low while RSI stays above the setup low; drawn from the
      // latest low of the setup whose RSI is below this one
      let j = ch.length - 1;
      while (j > 0 && ch[j].rsi >= pr) j--;
      const ref = ch[j];
      nDiv += 1;
      curTier = tierOf(nDiv, pr, P);
      ev.push({ type: 'div', k: nDiv, tier: curTier, bar: p, pbar: ppb, conf: i, rsi: pr, px: pp, refRsi: ref.rsi, refPx: ref.px, refBar: ref.bar, setRsi, setIdx });
      lastBar = p; lastRsi = pr; lastPBar = ppb; lastPx = pp;
      ch.push({ bar: p, rsi: pr, pbar: ppb, px: pp });
    } else if (pr <= P.startMax && (nDiv < 0 || pr <= setRsi)) {
      if (nDiv === 0 && ev.length && ev[ev.length - 1].type === 'setup') ev[ev.length - 1].replaced = true;
      nDiv = 0; curTier = 0; setRsi = pr; setBar = p;
      lastBar = p; lastRsi = pr; lastPBar = ppb; lastPx = pp;
      ch = [{ bar: p, rsi: pr, pbar: ppb, px: pp }];
      ev.push({ type: 'setup', bar: p, pbar: ppb, conf: i, rsi: pr, px: pp });
      setIdx = ev.length - 1;
    }
  }
  return { ev, rsi };
}

const day = t => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (a, b) => ((b / a - 1) * 100);

function main() {
  const args = process.argv.slice(2);
  const dir = args.shift();
  const json = args[0] === '--json' ? args.shift() : null;
  const stats = args[0] === '--stats' ? args.shift() : null;
  let syms = args.length ? args : fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));

  if (json) {
    const bars = load(dir, syms[0]);
    const { ev } = run(bars);
    console.log(JSON.stringify(ev.filter(e => !e.replaced).map(e => ({ type: e.type, k: e.k || 0, tier: e.tier || 0, conf: day(bars[e.conf].t), low: day(bars[e.bar].t), rsi: +e.rsi.toFixed(2) }))));
    return;
  }

  if (stats) {
    // forward returns from the close of the week each divergence confirms
    const H = [4, 13, 26, 52], agg = {};
    for (const s of syms) {
      const bars = load(dir, s);
      for (const e of run(bars).ev) {
        if (e.type !== 'div') continue;
        const a = (agg[e.tier] = agg[e.tier] || { n: 0, r: H.map(() => []), dd: [] });
        a.n++;
        const c0 = bars[e.conf].c;
        H.forEach((h, j) => { if (e.conf + h < bars.length) a.r[j].push(pct(c0, bars[e.conf + h].c)); });
        let mn = Infinity;
        for (let k = e.conf + 1; k <= Math.min(e.conf + 26, bars.length - 1); k++) mn = Math.min(mn, bars[k].l);
        if (mn < Infinity) a.dd.push(pct(c0, mn));
      }
    }
    const med = v => { if (!v.length) return NaN; const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const up = v => (v.length ? (100 * v.filter(x => x > 0).length) / v.length : NaN);
    console.log('colour      n   med4w  med13w med26w med52w  %up26w  %up52w  med worst dip in 26w');
    for (let t = 1; t <= 5; t++) {
      const a = agg[t]; if (!a) { console.log(NAMES[t].padEnd(10), '  0'); continue; }
      console.log(NAMES[t].padEnd(10), String(a.n).padStart(3), ...a.r.map(v => med(v).toFixed(1).padStart(7)), up(a.r[2]).toFixed(0).padStart(7), up(a.r[3]).toFixed(0).padStart(7), med(a.dd).toFixed(1).padStart(10));
    }
    return;
  }

  for (const s of syms) {
    const bars = load(dir, s);
    const { ev } = run(bars);
    const shown = ev.filter(e => !e.replaced);
    const nd = shown.filter(e => e.type === 'div').length;
    console.log(`\n${s}  (${bars.length} weeks, ${day(bars[0].t)} → ${day(bars[bars.length - 1].t)})  setups ${shown.length - nd}, divergences ${nd}`);
    for (let j = 0; j < shown.length; j++) {
      const e = shown[j];
      if (e.type === 'setup') {
        const hasDiv = shown[j + 1] && shown[j + 1].type === 'div' && shown[j + 1].k === 1;
        console.log(`  setup ${day(bars[e.bar].t)}  RSI ${e.rsi.toFixed(1)}  low ${e.px.toFixed(2)}${hasDiv ? '' : '   (no divergence)'}`);
      } else {
        console.log(`    DIV ${e.k} ${NAMES[e.tier].padEnd(9)} low ${day(bars[e.pbar].t)} (shown ${day(bars[e.conf].t)})  RSI ${e.refRsi.toFixed(1)} → ${e.rsi.toFixed(1)}  price ${e.refPx.toFixed(2)} → ${e.px.toFixed(2)}`);
      }
    }
  }
}

if (require.main === module) main();
module.exports = { run, rsiTV, load, tierOf };

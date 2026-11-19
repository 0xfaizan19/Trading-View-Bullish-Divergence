#!/usr/bin/env node
/* ============================================================================
 * Bullish Divergence · live scan (uses div_lab.js = the indicator's exact rules)
 * ----------------------------------------------------------------------------
 *   node scan_now.js <dataDir> <meta.json> [out.csv] [recentWeeks=8]
 *
 * dataDir   one Yahoo weekly chart JSON per symbol (<SYM>.json, "." → "-")
 * meta.json [{sym, name, sector, industry}] (e.g. the S&P 500 list)
 *
 * For every stock, on closed weekly bars only:
 *   CONFIRMED  a divergence confirmed in the last `recentWeeks` weekly closes
 *              (already drawn by the indicator)
 *   FORMING    the setup is live (RSI swing low ≤ 31 within 52 weeks) and the
 *              last 1-2 weeks hold a possible RSI swing low that is ABOVE the
 *              setup low while price is BELOW the setup's last low. It becomes
 *              a divergence if RSI stays above that low for the rest of the
 *              2 weekly closes the indicator waits for.
 *   UNDERCUT   live setup, nothing forming, but price is ALREADY below the
 *              setup's last low while RSI is above the setup low. RSI just
 *              hasn't printed a swing low the indicator counts (lowest of the
 *              5 weeks before it) - one more dip in RSI could confirm it.
 *   WATCH      live setup, nothing forming, latest weekly low 0-10% above
 *              the setup's last low: one more leg down with a higher RSI low
 *              would form one.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { run, tierOf } = require('./div_lab.js');

const P = { rsiLen: 14, startMax: 31, redLvl: 33, darkLvl: 35, useClose: false, lbL: 5, lbR: 2, pWin: 1, maxAge: 52 };
const NAMES = ['', 'Yellow', 'Orange', 'Light red', 'Red', 'Dark red'];
const day = t => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (a, b) => (b / a - 1) * 100;

// Yahoo weekly bars, closed weeks only. Yahoo stamps a week at Monday 00:00 New York time and can
// append an extra intraday row inside the current week; that row is dropped. The current week counts
// as closed once its Friday 16:00 New York close has passed (Monday stamp + 4 days 16 hours).
function loadClosed(dir, sym, now = Date.now() / 1000) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, sym + '.json'), 'utf8'));
  const r = j.chart.result[0], q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.low[i] == null || q.high[i] == null) continue;
    bars.push({ t: r.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  while (bars.length > 1 && bars[bars.length - 1].t - bars[bars.length - 2].t < 6 * 86400) bars.pop();
  if (bars.length && now < bars[bars.length - 1].t + 4 * 86400 + 16 * 3600) bars.pop();
  return bars;
}

function scan(bars, rw = 8) {
  const n = bars.length, last = n - 1;
  const { ev, rsi } = run(bars, P);
  const out = { close: bars[last].c, low: bars[last].l, rsiNow: rsi[last], lastWeek: day(bars[last].t) };
  let hi52 = 0; for (let k = Math.max(0, n - 52); k < n; k++) hi52 = Math.max(hi52, bars[k].h);
  out.offHigh = pct(hi52, out.close);
  out.recent = ev.filter(e => e.type === 'div' && e.conf >= n - rw).map(e => ({ ...e, setWeek: day(bars[ev[e.setIdx].bar].t), setPx: ev[e.setIdx].px, lowWeek: day(bars[e.pbar].t), confWeek: day(bars[e.conf].t) }));

  // the live setup = the last setup event plus the divergences after it
  let si = -1; for (let k = ev.length - 1; k >= 0; k--) if (ev[k].type === 'setup') { si = k; break; }
  if (si < 0) return out;
  const set = ev[si], chain = ev.slice(si + 1).filter(e => e.type === 'div');
  const lastLow = chain.length ? chain[chain.length - 1] : set;
  out.setup = { week: day(bars[set.bar].t), rsi: set.rsi, px: set.px };
  out.nDiv = chain.length;
  out.lastLowPx = lastLow.px;
  out.weeksSinceSetup = last - set.bar;
  out.live = last - set.bar <= P.maxAge;     // a swing low printing this week would still count
  if (!out.live) return out;

  // FORMING: a possible RSI swing low in the last 1-2 weeks, not confirmed yet
  for (const p of [last - 1, last]) {
    const pr = rsi[p];
    let ok = true;
    for (let k = 1; k <= P.lbL; k++) if (!(rsi[p - k] > pr)) ok = false;
    for (let k = p + 1; k <= last; k++) if (!(rsi[k] > pr)) ok = false;
    if (!ok) continue;
    let pp = Infinity; for (let k = p - 1; k <= Math.min(p + 1, last); k++) pp = Math.min(pp, bars[k].l);
    if (pr > set.rsi && pp < lastLow.px)
      out.forming = { week: day(bars[p].t), rsi: pr, px: pp, k: out.nDiv + 1, tier: tierOf(out.nDiv + 1, pr, P), closesLeft: P.lbR - (last - p) };
    else if (pr <= set.rsi)
      out.newSetup = { week: day(bars[p].t), rsi: pr };
  }
  if (!out.forming) out.distToLow = pct(lastLow.px, bars[last].l);
  return out;
}

if (require.main === module) {
  const [dir, metaPath, outCsv, rwArg] = process.argv.slice(2);
  const rw = +(rwArg || 8);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const rows = [], skipped = [], weeks = {};
  for (const m of meta) {
    const sym = m.sym.replace('.', '-');
    if (!fs.existsSync(path.join(dir, sym + '.json'))) { skipped.push(sym + ' (no data)'); continue; }
    const bars = loadClosed(dir, sym);
    if (bars.length < 30) { skipped.push(sym + ' (short history)'); continue; }
    const r = scan(bars, rw);
    weeks[r.lastWeek] = (weeks[r.lastWeek] || 0) + 1;
    rows.push({ ...m, sym, r });
  }
  console.log('last closed week per stock:', JSON.stringify(weeks), skipped.length ? '· skipped: ' + skipped.join(', ') : '');

  const conf = [], form = [], under = [], watch = [], newSet = [];
  for (const x of rows) {
    for (const e of x.r.recent) conf.push({ ...x, e });
    if (x.r.live && x.r.newSetup) newSet.push(x);
    else if (x.r.forming) form.push(x);
    else if (x.r.live && x.r.distToLow != null && x.r.distToLow < 0 && x.r.rsiNow > x.r.setup.rsi) under.push(x);
    else if (x.r.live && x.r.distToLow != null && x.r.distToLow >= 0 && x.r.distToLow <= 10) watch.push(x);
  }
  console.log(`${rows.length} stocks scanned · live setups (RSI swing low ≤ 31 in the last 52 weeks): ${rows.filter(x => x.r.live).length}`);

  const sg = v => (v >= 0 ? '+' : '') + v.toFixed(1);
  console.log(`\nCONFIRMED in the last ${rw} weekly closes (${conf.length}):`);
  conf.sort((a, b) => b.e.conf - a.e.conf || b.e.tier - a.e.tier);
  for (const { sym, name, sector, e, r } of conf)
    console.log(`  ${sym.padEnd(6)} ${NAMES[e.tier].padEnd(9)} #${e.k}  low wk ${e.lowWeek} $${e.px.toFixed(2)}  shown ${e.confWeek}  setup ${e.setWeek} RSI ${e.setRsi.toFixed(1)} → ${e.rsi.toFixed(1)}  now $${r.close.toFixed(2)} (${sg(pct(e.px, r.close))}% vs low)  RSI now ${r.rsiNow.toFixed(1)}  ${sector} · ${name}`);

  console.log(`\nFORMING, not confirmed yet (${form.length}):`);
  form.sort((a, b) => b.r.forming.tier - a.r.forming.tier);
  for (const { sym, name, sector, r } of form) {
    const f = r.forming;
    console.log(`  ${sym.padEnd(6)} would be ${NAMES[f.tier].padEnd(9)} #${f.k}  low wk ${f.week} $${f.px.toFixed(2)} < last low $${r.lastLowPx.toFixed(2)}  RSI ${f.rsi.toFixed(1)} > setup ${r.setup.rsi.toFixed(1)} (${r.setup.week})  ${f.closesLeft} more close(s)  now $${r.close.toFixed(2)}  ${sector} · ${name}`);
  }

  console.log(`\nUNDERCUT: price already below the setup's last low, RSI above the setup low, no counted RSI swing low yet (${under.length}):`);
  under.sort((a, b) => a.r.distToLow - b.r.distToLow);
  for (const { sym, name, sector, r } of under)
    console.log(`  ${sym.padEnd(6)} latest low ${r.distToLow.toFixed(1)}% under last low $${r.lastLowPx.toFixed(2)}  setup ${r.setup.week} RSI ${r.setup.rsi.toFixed(1)}  RSI now ${r.rsiNow.toFixed(1)}  divergences so far ${r.nDiv}  ${52 - r.weeksSinceSetup}w left  ${sector} · ${name}`);

  console.log(`\nWATCH: live setup, latest weekly low 0-10% above the setup's last low (${watch.length}):`);
  watch.sort((a, b) => a.r.distToLow - b.r.distToLow);
  for (const { sym, name, sector, r } of watch)
    console.log(`  ${sym.padEnd(6)} ${r.distToLow.toFixed(1).padStart(5)}% above last low $${r.lastLowPx.toFixed(2)}  setup ${r.setup.week} RSI ${r.setup.rsi.toFixed(1)}  divergences so far ${r.nDiv}  RSI now ${r.rsiNow.toFixed(1)}  ${52 - r.weeksSinceSetup}w left  ${sector} · ${name}`);

  if (newSet.length) console.log(`\nNew lower setup low possibly forming (RSI at/under the old setup low): ${newSet.map(x => x.sym + ' ' + x.r.newSetup.rsi.toFixed(1)).join(', ')}`);

  if (outCsv) {
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const L = ['group,ticker,name,sector,colour,divergence_no,low_week,price_low,rsi_low,setup_week,setup_rsi,setup_price_low,confirmed_week,closes_still_needed,last_close,pct_close_vs_low,rsi_now,pct_off_52w_high'];
    for (const { sym, name, sector, e, r } of conf)
      L.push(['confirmed', sym, q(name), q(sector), NAMES[e.tier], e.k, e.lowWeek, e.px.toFixed(2), e.rsi.toFixed(1), e.setWeek, e.setRsi.toFixed(1), e.setPx.toFixed(2), e.confWeek, 0, r.close.toFixed(2), pct(e.px, r.close).toFixed(1), r.rsiNow.toFixed(1), r.offHigh.toFixed(1)].join(','));
    for (const { sym, name, sector, r } of form) {
      const f = r.forming;
      L.push(['forming', sym, q(name), q(sector), NAMES[f.tier], f.k, f.week, f.px.toFixed(2), f.rsi.toFixed(1), r.setup.week, r.setup.rsi.toFixed(1), r.setup.px.toFixed(2), '', f.closesLeft, r.close.toFixed(2), pct(f.px, r.close).toFixed(1), r.rsiNow.toFixed(1), r.offHigh.toFixed(1)].join(','));
    }
    for (const { sym, name, sector, r } of under)
      L.push(['undercut', sym, q(name), q(sector), '', r.nDiv, '', r.lastLowPx.toFixed(2), '', r.setup.week, r.setup.rsi.toFixed(1), r.setup.px.toFixed(2), '', '', r.close.toFixed(2), r.distToLow.toFixed(1), r.rsiNow.toFixed(1), r.offHigh.toFixed(1)].join(','));
    for (const { sym, name, sector, r } of watch)
      L.push(['watch', sym, q(name), q(sector), '', r.nDiv, '', r.lastLowPx.toFixed(2), '', r.setup.week, r.setup.rsi.toFixed(1), r.setup.px.toFixed(2), '', '', r.close.toFixed(2), r.distToLow.toFixed(1), r.rsiNow.toFixed(1), r.offHigh.toFixed(1)].join(','));
    fs.writeFileSync(outCsv, L.join('\n') + '\n');
    console.log('\nwrote', outCsv);
  }
}
module.exports = { loadClosed, scan };

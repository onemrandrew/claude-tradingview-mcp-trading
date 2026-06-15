#!/usr/bin/env node
/**
 * Backtest Engine — claude-tradingview-mcp-trading
 *
 * Replays 2+ years of BitGet OHLCV data through the exact same scoreDayTrade()
 * and scoreSwing() logic used by the live bot. Simulates SL/TP fills on real
 * historical candle data and reports professional-grade performance metrics:
 * win rate, expectancy, Sharpe ratio, profit factor, max drawdown.
 *
 * NOTE: Scoring functions are duplicated here from bot.js (console.log removed
 * for speed). If you change indicator logic in bot.js, update here too.
 *
 * Usage:
 *   node backtest.js                             — full backtest, all symbols
 *   node backtest.js --symbol BTCUSDT            — single symbol
 *   node backtest.js --from 2024-01-01           — custom start date
 *   node backtest.js --style swing               — single style
 *   node backtest.js --threshold 90              — stricter entry filter
 */

import { writeFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

let SYMBOLS   = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
let STYLES    = ["day_trade", "swing"];  // scalp disabled — stale on hourly cron
let THRESHOLD = 85;
const BASE_URL = "https://api.bitget.com";

// Parse CLI flags
const args  = process.argv.slice(2);
const flag  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
// Collect all --symbol occurrences (e.g. --symbol BTCUSDT --symbol SOLUSDT)
const symbolFlags = args.reduce((acc, v, i) => (v === "--symbol" && args[i+1] ? [...acc, args[i+1]] : acc), []);
if (symbolFlags.length > 0) SYMBOLS = symbolFlags;
if (flag("--style"))     STYLES    = [flag("--style")];
if (flag("--threshold")) THRESHOLD = parseInt(flag("--threshold"), 10);
// --trail N : trail the runner half by N×ATR after TP1 (no TP2 cap, floored at breakeven).
//             Omit or 0 = control behaviour (breakeven stop + TP2 cap).
const TRAIL_ATR = flag("--trail") ? parseFloat(flag("--trail")) : 0;
// --live-trail : model the ACTUAL live-bot runner exit — after TP1 the stop trails
//   1.5×ATR behind the running peak of hourly closes, floored at breakeven, with the
//   TP2 cap kept. (The --trail mode above removes the cap; this one matches production.)
const LIVE_TRAIL = args.includes("--live-trail");
// TP1/TP2 ATR multiples — overridable for target sweeps. Defaults match live bot.
const TP1_MULT = flag("--tp1") ? parseFloat(flag("--tp1")) : 3.0;
const TP2_MULT = flag("--tp2") ? parseFloat(flag("--tp2")) : 4.0; // 4.0 = live default (swept winner)
// --cost F : round-trip cost as fraction of notional (fees+slippage). Each trade turns
//   over ~2× notional (entry 100% + exits 100%). BitGet taker = 0.06%/side → 0.0012
//   fees alone; add ~0.0004 slippage on market fills → ~0.0016 realistic. Default 0
//   (gross) to preserve prior behaviour. Converted to R per-trade from actual stop dist.
const COST_RT = flag("--cost") ? parseFloat(flag("--cost")) : 0;
// Per-style minimum score overrides (default to global THRESHOLD if unset).
const DT_MIN    = flag("--dt-min")    ? parseInt(flag("--dt-min"), 10)    : null;
const SWING_MIN = flag("--swing-min") ? parseInt(flag("--swing-min"), 10) : null;
// --max-concurrent N : portfolio-heat cap. Skip an entry if N positions are already
//   open across ALL symbols at that moment. 0/unset = unlimited (prior behaviour).
const MAX_CONCURRENT = flag("--max-concurrent") ? parseInt(flag("--max-concurrent"), 10) : 0;

// Greatest number of positions open simultaneously across all symbols (no cap).
function peakConcurrency(allTrades) {
  const ev = [];
  for (const t of allTrades) { ev.push([t.entryMs, 1]); ev.push([t.exitMs, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // process closes before opens at same ts
  let cur = 0, peak = 0;
  for (const [, d] of ev) { cur += d; if (cur > peak) peak = cur; }
  return peak;
}

// Drop entries that would exceed `maxOpen` concurrent positions (chronological, greedy).
// Approximates live: a capped symbol simply doesn't take that setup. Conservative on
// trade count (doesn't re-derive signals freed up by skipping), but correct on the
// drawdown clusters the cap is meant to prevent.
function applyHeatCap(allTrades, maxOpen) {
  const sorted = [...allTrades].sort((a, b) => a.entryMs - b.entryMs);
  const kept = [], openExits = [];
  for (const t of sorted) {
    for (let k = openExits.length - 1; k >= 0; k--) if (openExits[k] <= t.entryMs) openExits.splice(k, 1);
    if (openExits.length >= maxOpen) continue;
    kept.push(t);
    openExits.push(t.exitMs);
  }
  return kept;
}

const FROM_ISO = flag("--from") || "2023-01-01";
const TO_ISO   = flag("--to")   || new Date().toISOString().slice(0, 10);
const FROM_MS  = new Date(FROM_ISO + "T00:00:00Z").getTime();
const TO_MS    = new Date(TO_ISO   + "T23:59:59Z").getTime();

// Warm-up: load this much data BEFORE FROM_MS so indicators have full windows.
// 1H needs 250 bars (~10 days), 4H needs 250 bars (~42 days), 1D needs 300 bars (~300 days).
const WARMUP_MS = 320 * 24 * 60 * 60 * 1000; // 320 days — covers all three timeframes
const LOAD_FROM = FROM_MS - WARMUP_MS;

// ─── Data Fetching ────────────────────────────────────────────────────────────
// BitGet /api/v2/mix/market/history-candles paginates oldest→newest via endTime.
// NOTE: history-candles only returns ~90 bars for 1D granularity (API limitation).
// Instead, daily candles are derived from the 4H data via buildDailyFromH4().

function buildDailyFromH4(h4Candles) {
  const days = {};
  for (const c of h4Candles) {
    const day = new Date(c.time).toISOString().slice(0, 10);
    if (!days[day]) {
      days[day] = { time: new Date(day + "T00:00:00Z").getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      if (c.high > days[day].high) days[day].high = c.high;
      if (c.low  < days[day].low)  days[day].low  = c.low;
      days[day].close  = c.close;
      days[day].volume += c.volume;
    }
  }
  return Object.values(days).sort((a, b) => a.time - b.time);
}

async function fetchHistoricalCandles(symbol, granularity, startMs, endMs) {
  const all    = [];
  let   cursor = endMs;

  // history-candles supports endTime-only pagination — no startTime needed.
  // Paginate backwards: each page ends just before the oldest bar in the prior page.
  while (true) {
    const url = `${BASE_URL}/api/v2/mix/market/history-candles?symbol=${symbol}`
              + `&productType=usdt-futures&granularity=${granularity}`
              + `&endTime=${cursor}&limit=200`;
    let data;
    try {
      const res = await fetch(url);
      data = await res.json();
    } catch (err) {
      console.error(`    Fetch error: ${err.message}`); break;
    }
    if (data.code !== "00000") { console.error(`    API error: ${data.msg}`); break; }

    const batch = data.data || [];
    if (batch.length === 0) break;

    for (const k of batch) {
      all.push({
        time:   parseInt(k[0]),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }

    // Find oldest timestamp in this batch — candles may be ascending or descending
    const times  = batch.map(k => parseInt(k[0]));
    const oldest = Math.min(...times);
    if (oldest <= startMs || batch.length < 200) break;
    cursor = oldest - 1;
    await new Promise(r => setTimeout(r, 120)); // ~8 req/s
  }

  // Sort ascending, deduplicate, trim to requested range
  all.sort((a, b) => a.time - b.time);
  const seen = new Set();
  return all
    .filter(c => !seen.has(c.time) && seen.add(c.time))
    .filter(c => c.time >= startMs && c.time <= endMs);
}

// ─── Indicators ───────────────────────────────────────────────────────────────
// Keep in sync with bot.js. console.log removed — runs thousands of times.

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const mf = 2 / (fast + 1), ms = 2 / (slow + 1), mg = 2 / (signal + 1);
  let ef = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  for (let i = fast; i < slow; i++) ef = closes[i] * mf + ef * (1 - mf);
  let es = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  const series = [];
  for (let i = slow; i < closes.length; i++) {
    ef = closes[i] * mf + ef * (1 - mf);
    es = closes[i] * ms + es * (1 - ms);
    series.push(ef - es);
  }
  if (series.length < signal) return null;
  let sig = series.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < series.length; i++) sig = series[i] * mg + sig * (1 - mg);
  const macdLine = series[series.length - 1];
  return { macdLine, signalLine: sig, histogram: macdLine - sig };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return null;
  const trs = [], pDMs = [], mDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pDM = pDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let mDM = mDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxVals = [];
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i];
    pDM = pDM - pDM / period + pDMs[i];
    mDM = mDM - mDM / period + mDMs[i];
    if (atr === 0) continue;
    const pDI = (pDM / atr) * 100, mDI = (mDM / atr) * 100;
    dxVals.push({ dx: Math.abs(pDI - mDI) / (pDI + mDI) * 100, pDI, mDI });
  }
  if (dxVals.length < period) return null;
  let adx = dxVals.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dxVals.length; i++) adx = (adx * (period - 1) + dxVals[i].dx) / period;
  const last = dxVals[dxVals.length - 1];
  return { adx, plusDI: last.pDI, minusDI: last.mDI };
}

function detectCrossover(closes, fp, sp) {
  if (closes.length < Math.max(fp, sp) + 2) return "none";
  function emaPair(arr, p) {
    if (arr.length < p + 1) return [null, null];
    const m = 2 / (p + 1);
    let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p, prev = e;
    for (let i = p; i < arr.length; i++) { prev = e; e = arr[i] * m + e * (1 - m); }
    return [prev, e];
  }
  const [fp0, fn] = emaPair(closes, fp);
  const [sp0, sn] = emaPair(closes, sp);
  if (fn === null || sn === null) return "none";
  if (fp0 <= sp0 && fn > sn) return "bullish";
  if (fp0 >= sp0 && fn < sn) return "bearish";
  return fn > sn ? "above" : "below";
}

function volumeAboveMA(candles, period = 20, mult = 1.0) {
  if (candles.length < period + 2) return false;
  const recent = candles.slice(-period - 2, -2);
  const avg = recent.reduce((s, c) => s + c.volume, 0) / period;
  return candles[candles.length - 2].volume >= avg * mult;
}

function priceStructure(candles, lookback = 10) {
  if (candles.length < lookback * 2) return null;
  const r = candles.slice(-lookback), p = candles.slice(-lookback * 2, -lookback);
  const rH = Math.max(...r.map(c => c.high)), rL = Math.min(...r.map(c => c.low));
  const pH = Math.max(...p.map(c => c.high)), pL = Math.min(...p.map(c => c.low));
  return { higherHigh: rH > pH, higherLow: rL > pL, lowerHigh: rH < pH, lowerLow: rL < pL };
}

function calcBollinger(closes, period = 20, sd = 2) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const mean = s.reduce((a, b) => a + b, 0) / period;
  const std  = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { middle: mean, upper: mean + sd * std, lower: mean - sd * std };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
// Exact copies of scoreDayTrade() and scoreSwing() from bot.js.
// All console.log calls removed for backtest performance.

function scoreDayTrade(c1h, c4h, direction) {
  const cl1h = c1h.map(c => c.close), cl4h = c4h.map(c => c.close);
  const price = cl1h[cl1h.length - 1];
  const ema21_1h  = calcEMA(cl1h, 21);
  const rsi14_1h  = calcRSI(cl1h, 14);
  const macd_1h   = calcMACD(cl1h);
  const ema200_4h = calcEMA(cl4h, Math.min(200, cl4h.length - 1));
  const rsi14_4h  = calcRSI(cl4h, 14);
  const ema21_4h  = calcEMA(cl4h, 21);
  const ema55_4h  = calcEMA(cl4h, 55);
  const last4h    = c4h[c4h.length - 1];
  const struct1h  = priceStructure(c1h, 8);
  const cross1h   = detectCrossover(cl1h, 21, 55);
  const volOK     = volumeAboveMA(c1h, 20, 1.0);
  const atr14_1h  = calcATR(c1h, 14);
  const atrBase1h = calcATR(c1h, 20);
  if (atrBase1h && atr14_1h && atr14_1h > atrBase1h * 3)
    return { score: 0, direction: null, conditions: [], atr: atr14_1h, price, style: "day_trade" };
  const adx1h = calcADX(c1h, 14);

  const conds = [], chk = (l, p) => conds.push({ label: l, pass: !!p });
  if (direction === "long") {
    chk("Price above 200 EMA on 4H",         ema200_4h && price > ema200_4h);
    chk("EMA 21 ≥ EMA 55 on 1H",             cross1h === "bullish" || cross1h === "above");
    chk("RSI(14) below 45 on 1H",            rsi14_1h !== null && rsi14_1h < 45);
    chk("MACD histogram positive on 1H",     macd_1h && macd_1h.histogram > 0);
    chk("Volume above 20-period MA on 1H",   volOK);
    chk("4H candle closed bullish",          last4h && last4h.close > last4h.open);
    chk("Higher high and higher low on 1H",  struct1h && struct1h.higherHigh && struct1h.higherLow);
    chk("Price above EMA 21 on 1H",          ema21_1h && price > ema21_1h);
    chk("4H RSI(14) above 50",               rsi14_4h !== null && rsi14_4h > 50);
    chk("ADX(14) ≥ 20 on 1H",                adx1h && adx1h.adx >= 20);
  } else {
    chk("Price below 200 EMA on 4H",         ema200_4h && price < ema200_4h);
    chk("EMA 21 ≤ EMA 55 on 1H",             cross1h === "bearish" || cross1h === "below");
    chk("RSI(14) above 55 on 1H",            rsi14_1h !== null && rsi14_1h > 55);
    chk("MACD histogram negative on 1H",     macd_1h && macd_1h.histogram < 0);
    chk("Volume above 20-period MA on 1H",   volOK);
    chk("4H candle closed bearish",          last4h && last4h.close < last4h.open);
    chk("Lower high and lower low on 1H",    struct1h && struct1h.lowerHigh && struct1h.lowerLow);
    chk("Price below EMA 21 on 1H",          ema21_1h && price < ema21_1h);
    chk("4H RSI(14) below 50",               rsi14_4h !== null && rsi14_4h < 50);
    chk("ADX(14) ≥ 20 on 1H",                adx1h && adx1h.adx >= 20);
  }
  return { score: conds.filter(c => c.pass).length * 10, conditions: conds, atr: atr14_1h, price, style: "day_trade" };
}

function scoreSwing(c4h, c1d, direction) {
  const cl4h = c4h.map(c => c.close), cl1d = c1d.map(c => c.close);
  const price = cl4h[cl4h.length - 1];
  const ema21_4h  = calcEMA(cl4h, 21);
  const rsi14_4h  = calcRSI(cl4h, 14);
  const macd_4h   = calcMACD(cl4h);
  const bb_4h     = calcBollinger(cl4h, 20, 2);
  const ema200_1d = calcEMA(cl1d, Math.min(200, cl1d.length - 1));
  const ema21_1d  = calcEMA(cl1d, 21);
  const ema55_1d  = calcEMA(cl1d, 55);
  const last1d    = c1d[c1d.length - 1];
  const prev1d    = c1d[c1d.length - 2];
  const struct4h  = priceStructure(c4h, 8);
  const cross4h   = detectCrossover(cl4h, 21, 55);
  const volOK     = volumeAboveMA(c4h, 20, 1.0);
  const atr14_4h  = calcATR(c4h, 14);
  const atrBase4h = calcATR(c4h, 20);
  if (atrBase4h && atr14_4h && atr14_4h > atrBase4h * 3)
    return { score: 0, direction: null, conditions: [], atr: atr14_4h, price, style: "swing" };
  const adx4h = calcADX(c4h, 14);

  const conds = [], chk = (l, p) => conds.push({ label: l, pass: !!p });
  if (direction === "long") {
    chk("Price above 200 EMA on Daily",      ema200_1d && price > ema200_1d);
    chk("EMA 21 ≥ EMA 55 on 4H",             cross4h === "bullish" || cross4h === "above");
    chk("RSI(14) below 45 on 4H",            rsi14_4h !== null && rsi14_4h < 45);
    chk("MACD histogram positive on 4H",     macd_4h && macd_4h.histogram > 0);
    chk("Volume above 20-period MA on 4H",   volOK);
    chk("Price above Bollinger middle",      bb_4h && price > bb_4h.middle);
    chk("Higher high and higher low on 4H",  struct4h && struct4h.higherHigh && struct4h.higherLow);
    chk("Price above EMA 21 on 4H",          ema21_4h && price > ema21_4h);
    chk("Daily candle above prior high",     last1d && prev1d && last1d.close > prev1d.high);
    chk("ADX(14) ≥ 20 on 4H",                adx4h && adx4h.adx >= 20);
  } else {
    chk("Price below 200 EMA on Daily",      ema200_1d && price < ema200_1d);
    chk("EMA 21 ≤ EMA 55 on 4H",             cross4h === "bearish" || cross4h === "below");
    chk("RSI(14) above 55 on 4H",            rsi14_4h !== null && rsi14_4h > 55);
    chk("MACD histogram negative on 4H",     macd_4h && macd_4h.histogram < 0);
    chk("Volume above 20-period MA on 4H",   volOK);
    chk("Price below Bollinger middle",      bb_4h && price < bb_4h.middle);
    chk("Lower high and lower low on 4H",    struct4h && struct4h.lowerHigh && struct4h.lowerLow);
    chk("Price below EMA 21 on 4H",          ema21_4h && price < ema21_4h);
    chk("Daily candle below prior low",      last1d && prev1d && last1d.close < prev1d.low);
    chk("ADX(14) ≥ 20 on 4H",                adx4h && adx4h.adx >= 20);
  }
  return { score: conds.filter(c => c.pass).length * 10, conditions: conds, atr: atr14_4h, price, style: "swing" };
}

function computeLevels(direction, entry, atr, style) {
  // day_trade: 2.5× SL — 1H candles are wick-prone; wider stop survives stop hunts.
  // swing:     2.0× SL — 4H candles are smoother, tighter stop is fine.
  // TP1/TP2 ATR multiples overridable via --tp1 / --tp2 for sweeps (default 3.0 / 6.0).
  const mult = style === "day_trade"
    ? { sl: 2.5, tp1: TP1_MULT, tp2: TP2_MULT }
    : { sl: 2.0, tp1: TP1_MULT, tp2: TP2_MULT };
  return direction === "long"
    ? { stopLoss: entry - mult.sl * atr, takeProfit1: entry + mult.tp1 * atr, takeProfit2: entry + mult.tp2 * atr }
    : { stopLoss: entry + mult.sl * atr, takeProfit1: entry - mult.tp1 * atr, takeProfit2: entry - mult.tp2 * atr };
}

// ─── News Blackout ────────────────────────────────────────────────────────────
// Historical FOMC and CPI dates 2023–2025. Keep in sync with bot.js NEWS_EVENTS_2026.

const NEWS_EVENTS = [
  // 2023
  { date: "2023-01-12", h: 13 }, { date: "2023-02-01", h: 19 }, { date: "2023-02-14", h: 13 },
  { date: "2023-03-14", h: 13 }, { date: "2023-03-22", h: 18 }, { date: "2023-04-12", h: 12 },
  { date: "2023-05-03", h: 18 }, { date: "2023-05-10", h: 12 }, { date: "2023-06-13", h: 12 },
  { date: "2023-06-14", h: 18 }, { date: "2023-07-12", h: 12 }, { date: "2023-07-26", h: 18 },
  { date: "2023-08-10", h: 12 }, { date: "2023-09-13", h: 12 }, { date: "2023-09-20", h: 18 },
  { date: "2023-10-12", h: 12 }, { date: "2023-11-01", h: 18 }, { date: "2023-11-14", h: 13 },
  { date: "2023-12-12", h: 13 }, { date: "2023-12-13", h: 19 },
  // 2024
  { date: "2024-01-11", h: 13 }, { date: "2024-01-31", h: 19 }, { date: "2024-02-13", h: 13 },
  { date: "2024-03-12", h: 13 }, { date: "2024-03-20", h: 18 }, { date: "2024-04-10", h: 12 },
  { date: "2024-05-01", h: 18 }, { date: "2024-05-15", h: 12 }, { date: "2024-06-12", h: 12 },
  { date: "2024-06-12", h: 18 }, { date: "2024-07-11", h: 12 }, { date: "2024-07-31", h: 18 },
  { date: "2024-08-14", h: 12 }, { date: "2024-09-11", h: 12 }, { date: "2024-09-18", h: 18 },
  { date: "2024-10-10", h: 12 }, { date: "2024-11-07", h: 19 }, { date: "2024-11-13", h: 13 },
  { date: "2024-12-11", h: 13 }, { date: "2024-12-18", h: 19 },
  // 2025
  { date: "2025-01-15", h: 13 }, { date: "2025-01-29", h: 19 }, { date: "2025-02-12", h: 13 },
  { date: "2025-03-12", h: 13 }, { date: "2025-03-19", h: 18 }, { date: "2025-04-10", h: 12 },
  { date: "2025-05-07", h: 18 }, { date: "2025-05-13", h: 12 },
];

function isNewsBlackout(tsMs) {
  const d = new Date(tsMs);
  const date = d.toISOString().slice(0, 10);
  const h    = d.getUTCHours();
  return NEWS_EVENTS.some(e => e.date === date && h >= e.h - 1 && h <= e.h + 2);
}

// ─── Trade Simulator ──────────────────────────────────────────────────────────
// Walks forward on 1H candles from the entry bar.
// Returns outcome + P&L in R (1R = dollar risk per trade).
//
// P&L in R:
//   SL hit                    : -1.00R
//   TP1 hit → then SL(BE)     : +0.75R  (+1.5R × 50% + 0 × 50%)
//   TP1 hit → then TP2 hit    : +2.25R  (+1.5R × 50% + 3R × 50%)
//   Price gaps straight to TP2: +3.00R  (full size, rare)
//   Expired after TP1         : +0.75R  (remaining half closed at BE — conservative)
//   Expired flat              :  0.00R  (neither SL nor TP1 hit, close at entry)

function simulateTrade(direction, entryPrice, levels, futureCandles, style, trailAtrMult = 0) {
  const r = simulateTradeRaw(direction, entryPrice, levels, futureCandles, style, trailAtrMult);
  if (COST_RT <= 0) return r;
  // Round-trip fees+slippage in R: cost on notional ÷ dollar risk = COST_RT × entry ÷ stop distance.
  const feeR = COST_RT * entryPrice / Math.abs(entryPrice - levels.stopLoss);
  return { ...r, pnl: r.pnl - feeR };
}

function simulateTradeRaw(direction, entryPrice, levels, futureCandles, style, trailAtrMult = 0) {
  const { stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2 } = levels;
  const maxBars = style === "swing" ? 240 : 96; // 10 days swing / 4 days day_trade
  const sign    = direction === "long" ? 1 : -1;
  const R       = Math.abs(entryPrice - sl);           // 1R in price terms = actual stop distance
  const atrDist = Math.abs(tp1 - entryPrice) / TP1_MULT; // back out ATR from tp1 distance
  const trailD  = trailAtrMult * atrDist;
  // R contribution of closing `frac` of the position at price p
  const rOf = (p, frac) => frac * sign * (p - entryPrice) / R;
  const TP1_R = rOf(tp1, 0.5);                          // booked when the first half exits

  let tp1Hit = false;
  let peak   = entryPrice;                              // best price reached since TP1 (high for long, low for short)
  let peakClose = entryPrice;                           // running peak of CLOSES since TP1 (live-trail model)
  const n = Math.min(maxBars, futureCandles.length);

  for (let j = 0; j < n; j++) {
    const c = futureCandles[j];
    if (!tp1Hit) {
      // Pre-TP1: original stop and targets. Gap straight through TP1 → full close at TP2.
      if (direction === "long") {
        if (c.low  <= sl)  return { outcome: "SL",  pnl: -1.00,          barsHeld: j + 1 };
        if (c.high >= tp2) return { outcome: "TP2", pnl: rOf(tp2, 1.0),  barsHeld: j + 1 };
        if (c.high >= tp1) { tp1Hit = true; peak = c.high; peakClose = c.close; continue; }
      } else {
        if (c.high >= sl)  return { outcome: "SL",  pnl: -1.00,          barsHeld: j + 1 };
        if (c.low  <= tp2) return { outcome: "TP2", pnl: rOf(tp2, 1.0),  barsHeld: j + 1 };
        if (c.low  <= tp1) { tp1Hit = true; peak = c.low; peakClose = c.close; continue; }
      }
    } else if (LIVE_TRAIL) {
      // Production model: stop trails 1.5×ATR behind the running peak of hourly CLOSES
      // (the bot samples mark price each hour and ratchets up), floored at breakeven;
      // TP2 cap kept. Exit at whichever hits first. peakClose excludes the current bar's
      // close (updated after the check) to avoid lookahead. Conservatively check the
      // stop before TP2 within a bar.
      const ltD = 1.5 * atrDist;
      if (direction === "long") {
        const trailStop = Math.max(entryPrice, peakClose - ltD);
        if (c.low  <= trailStop) return { outcome: "TP1_TRAIL", pnl: TP1_R + rOf(trailStop, 0.5), barsHeld: j + 1 };
        if (c.high >= tp2)       return { outcome: "TP1_TP2",   pnl: TP1_R + rOf(tp2, 0.5),       barsHeld: j + 1 };
        if (c.close > peakClose) peakClose = c.close;
      } else {
        const trailStop = Math.min(entryPrice, peakClose + ltD);
        if (c.high >= trailStop) return { outcome: "TP1_TRAIL", pnl: TP1_R + rOf(trailStop, 0.5), barsHeld: j + 1 };
        if (c.low  <= tp2)       return { outcome: "TP1_TP2",   pnl: TP1_R + rOf(tp2, 0.5),       barsHeld: j + 1 };
        if (c.close < peakClose) peakClose = c.close;
      }
    } else if (trailAtrMult > 0) {
      // Runner half: trailing stop floored at breakeven, NO upper cap. peak excludes this
      // bar's extreme (updated after the check) to avoid intrabar lookahead.
      if (direction === "long") {
        const trailStop = Math.max(peak - trailD, entryPrice);
        if (c.low <= trailStop) return { outcome: "TP1_TRAIL", pnl: TP1_R + rOf(trailStop, 0.5), barsHeld: j + 1 };
        if (c.high > peak) peak = c.high;
      } else {
        const trailStop = Math.min(peak + trailD, entryPrice);
        if (c.high >= trailStop) return { outcome: "TP1_TRAIL", pnl: TP1_R + rOf(trailStop, 0.5), barsHeld: j + 1 };
        if (c.low < peak) peak = c.low;
      }
    } else {
      // Control runner: breakeven stop + TP2 cap.
      if (direction === "long") {
        if (c.low  <= entryPrice) return { outcome: "TP1_BE",  pnl: TP1_R,                 barsHeld: j + 1 };
        if (c.high >= tp2)        return { outcome: "TP1_TP2", pnl: TP1_R + rOf(tp2, 0.5), barsHeld: j + 1 };
      } else {
        if (c.high >= entryPrice) return { outcome: "TP1_BE",  pnl: TP1_R,                 barsHeld: j + 1 };
        if (c.low  <= tp2)        return { outcome: "TP1_TP2", pnl: TP1_R + rOf(tp2, 0.5), barsHeld: j + 1 };
      }
    }
  }

  const barsHeld = n;
  if (!tp1Hit) return { outcome: "EXPIRED", pnl: 0.00, barsHeld }; // neither SL nor TP1 hit
  // Expired after TP1: close the runner at the last available close.
  const lastClose = futureCandles[n - 1].close;
  return { outcome: "TP1_EXPIRED", pnl: TP1_R + rOf(lastClose, 0.5), barsHeld };
}

// ─── Binary search: last candle with time <= targetMs ─────────────────────────
function lastIdxBefore(candles, targetMs) {
  let lo = 0, hi = candles.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= targetMs) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runBacktest() {
  const HR = "═".repeat(58);
  const LN = "─".repeat(58);
  console.log(HR);
  console.log("  Backtest Engine — claude-tradingview-mcp-trading");
  console.log(`  Period  : ${FROM_ISO}  →  ${TO_ISO}`);
  console.log(`  Symbols : ${SYMBOLS.join(", ")}`);
  console.log(`  Styles  : ${STYLES.join(", ")}`);
  console.log(`  Min score : ${THRESHOLD}/100`);
  console.log(HR + "\n");

  // ── 1. Load historical candle data ──────────────────────────────────────
  console.log("Loading historical candle data...\n");
  const raw = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym}  1H... `);
    const h1 = await fetchHistoricalCandles(sym, "1H", LOAD_FROM, TO_MS);
    process.stdout.write(`${h1.length} bars   4H... `);
    const h4 = await fetchHistoricalCandles(sym, "4H", LOAD_FROM, TO_MS);
    const d1 = buildDailyFromH4(h4);
    console.log(`${h4.length} bars   1D... ${d1.length} bars (derived from 4H)`);
    raw[sym] = { h1, h4, d1 };
  }
  console.log();

  // ── 2. Walk-forward simulation ───────────────────────────────────────────
  console.log("Running simulation...\n");
  let trades = [];

  for (const sym of SYMBOLS) {
    const { h1, h4, d1 } = raw[sym];
    let startIdx = h1.findIndex(c => c.time >= FROM_MS);
    if (startIdx < 0) { console.log(`  ${sym}: no data from ${FROM_ISO}`); continue; }
    if (startIdx < 250) startIdx = 250;

    let cooldownUntil = 0;
    let symTrades = 0;

    for (let i = startIdx; i < h1.length - 1; i++) {
      const ts = h1[i].time;
      if (ts > TO_MS) break;
      if (ts < cooldownUntil) continue;   // position open or cooldown active
      if (isNewsBlackout(ts)) continue;   // news blackout window

      // Build candle windows
      const c1h = h1.slice(Math.max(0, i - 249), i + 1);
      const i4  = lastIdxBefore(h4, ts);
      const id  = lastIdxBefore(d1, ts);
      if (i4 < 249 || id < 299) continue; // not enough warm-up

      const c4h = h4.slice(i4 - 249, i4 + 1);
      const cd1 = d1.slice(id - 299, id + 1);

      // Score all enabled styles × 2 directions
      const setups = [];
      if (STYLES.includes("day_trade")) {
        setups.push({ ...scoreDayTrade(c1h, c4h, "long"),  direction: "long"  });
        setups.push({ ...scoreDayTrade(c1h, c4h, "short"), direction: "short" });
      }
      if (STYLES.includes("swing")) {
        setups.push({ ...scoreSwing(c4h, cd1, "long"),  direction: "long"  });
        setups.push({ ...scoreSwing(c4h, cd1, "short"), direction: "short" });
      }

      // Backtest-derived thresholds: shorts and ETH need more conviction.
      const SHORT_THRESHOLD = THRESHOLD;       // shorts use same bar as longs (matches live)
      const ETH_THRESHOLD   = THRESHOLD + 5;

      // Pick best qualifying setup (swing preferred on score ties ≤10pts)
      const styleRank = { swing: 0, day_trade: 1 };
      const qualifying = setups
        .filter(s => {
          if (s.direction === "short" && s.score < SHORT_THRESHOLD) return false;
          if (sym === "ETHUSDT"       && s.score < ETH_THRESHOLD)   return false;
          const styleMin = s.style === "day_trade" && DT_MIN    != null ? DT_MIN
                         : s.style === "swing"     && SWING_MIN != null ? SWING_MIN
                         : THRESHOLD;
          return s.score >= styleMin;
        })
        .sort((a, b) =>
          Math.abs(a.score - b.score) <= 10
            ? styleRank[a.style] - styleRank[b.style]
            : b.score - a.score
        );
      if (qualifying.length === 0) continue;

      const best  = qualifying[0];
      const entry = h1[i].close;
      const atr   = best.atr;
      if (!atr || atr <= 0) continue;

      const levels    = computeLevels(best.direction, entry, atr, best.style);
      const slDistPct = Math.abs(levels.stopLoss - entry) / entry;
      if (slDistPct < 0.001) continue; // ATR floor — stop too tight

      // Macro veto: price must be on the correct side of 4H EMA(200)
      const ema200 = calcEMA(c4h.map(c => c.close), Math.min(200, c4h.length - 1));
      if (ema200) {
        if (best.direction === "long"  && entry < ema200) continue;
        if (best.direction === "short" && entry > ema200) continue;
      }

      // Simulate forward on 1H candles
      const future = h1.slice(i + 1);
      const result = simulateTrade(best.direction, entry, levels, future, best.style, TRAIL_ATR);

      trades.push({
        ts:        new Date(ts).toISOString(),
        entryMs:   ts,
        exitMs:    ts + result.barsHeld * 60 * 60 * 1000,
        symbol:    sym,
        style:     best.style,
        direction: best.direction,
        score:     best.score,
        entry,
        sl:        levels.stopLoss,
        tp1:       levels.takeProfit1,
        tp2:       levels.takeProfit2,
        atr,
        outcome:   result.outcome,
        pnl:       result.pnl,
      });

      // Cooldown = hold duration + 2h buffer (prevents re-entry on same setup)
      cooldownUntil = ts + (result.barsHeld + 2) * 60 * 60 * 1000;
      symTrades++;
    }

    console.log(`  ${sym}: ${symTrades} trades simulated`);
  }

  if (trades.length === 0) {
    console.log("\n⚠️  No trades generated. Try a lower --threshold or wider --from date.");
    return;
  }

  // Chronological order across ALL symbols — required for a true portfolio equity
  // curve / drawdown (trades were pushed grouped by symbol, not by time).
  trades.sort((a, b) => a.entryMs - b.entryMs);

  const peakOpen = peakConcurrency(trades);
  if (MAX_CONCURRENT > 0) {
    const before = trades.length;
    trades = applyHeatCap(trades, MAX_CONCURRENT);
    console.log(`\n⚖️  Heat cap ${MAX_CONCURRENT}: kept ${trades.length}/${before} trades (peak concurrency uncapped was ${peakOpen}).`);
  } else {
    console.log(`\n📈 Peak concurrent positions (uncapped): ${peakOpen}`);
  }

  // ── 3. Metrics ───────────────────────────────────────────────────────────
  const wins     = trades.filter(t => t.pnl > 0);
  const losses   = trades.filter(t => t.pnl <= 0);
  const winRate  = wins.length / trades.length;
  const avgWin   = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const expect   = winRate * avgWin + (1 - winRate) * avgLoss;
  const grossW   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf       = grossL > 0 ? grossW / grossL : Infinity;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Equity curve + max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, peak - equity);
  }

  // Sharpe ratio (annualised, risk-free = 0)
  const byDay = {};
  for (const t of trades) {
    const d = t.ts.slice(0, 10);
    byDay[d] = (byDay[d] || 0) + t.pnl;
  }
  const daily = Object.values(byDay);
  const meanD = daily.reduce((a, b) => a + b, 0) / daily.length;
  const stdD  = Math.sqrt(daily.reduce((s, r) => s + (r - meanD) ** 2, 0) / daily.length);
  const sharpe = stdD > 0 ? (meanD / stdD) * Math.sqrt(252) : 0;

  // Streaks
  let maxW = 0, maxL = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnl > 0) { cw++; cl = 0; maxW = Math.max(maxW, cw); }
    else            { cl++; cw = 0; maxL = Math.max(maxL, cl); }
  }

  // Group helpers
  const group = (key) => trades.reduce((m, t) => {
    (m[t[key]] = m[t[key]] || []).push(t); return m;
  }, {});
  const groupMetrics = (ts) => {
    const w = ts.filter(t => t.pnl > 0);
    return {
      count: ts.length,
      wr:    ts.length ? w.length / ts.length : 0,
      exp:   ts.length ? ts.reduce((s, t) => s + t.pnl, 0) / ts.length : 0,
    };
  };

  // Outcome counts
  const outcomes = trades.reduce((m, t) => { m[t.outcome] = (m[t.outcome] || 0) + 1; return m; }, {});

  // ── 4. Report ────────────────────────────────────────────────────────────
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const r2  = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
  const r3  = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(3)}R`;
  const usd = (n) => `${n >= 0 ? "+" : ""}$${Math.abs(n * 5).toFixed(2)}`;

  console.log(`\n${HR}`);
  console.log(`  BACKTEST RESULTS  —  ${FROM_ISO}  →  ${TO_ISO}`);
  console.log(`  Symbols: ${SYMBOLS.join(", ")}   Styles: ${STYLES.join(", ")}   Min: ${THRESHOLD}`);
  console.log(`${HR}\n`);

  console.log("Overall Performance");
  console.log(LN);
  console.log(`  Total trades        : ${trades.length}`);
  console.log(`  Win rate            : ${pct(winRate)}  (${wins.length} wins / ${losses.length} losses)`);
  console.log(`  Avg win             : ${r2(avgWin)}`);
  console.log(`  Avg loss            : ${r2(avgLoss)}`);
  console.log(`  Expectancy          : ${r3(expect)} per trade`);
  console.log(`  Profit factor       : ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
  console.log(`  Sharpe ratio        : ${sharpe.toFixed(2)}  (annualised)`);
  console.log(`  Total P&L           : ${r2(totalPnl)}`);
  console.log(`  Max drawdown        : -${maxDD.toFixed(2)}R`);
  console.log(`  Best streak         : ${maxW} wins`);
  console.log(`  Worst streak        : ${maxL} losses\n`);

  console.log("Outcome Breakdown");
  console.log(LN);
  for (const [k, v] of Object.entries(outcomes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)}: ${String(v).padStart(4)}  (${pct(v / trades.length)})`);
  }
  console.log();

  console.log("By Style");
  console.log(LN);
  for (const [style, ts] of Object.entries(group("style"))) {
    const m = groupMetrics(ts);
    console.log(`  ${style.padEnd(12)}: ${String(m.count).padStart(4)} trades  ${pct(m.wr)} win  ${r3(m.exp)} expectancy`);
  }
  console.log();

  console.log("By Symbol");
  console.log(LN);
  for (const [sym, ts] of Object.entries(group("symbol"))) {
    const m = groupMetrics(ts);
    console.log(`  ${sym.padEnd(10)}: ${String(m.count).padStart(4)} trades  ${pct(m.wr)} win  ${r3(m.exp)} expectancy`);
  }
  console.log();

  console.log("By Direction");
  console.log(LN);
  for (const [dir, ts] of Object.entries(group("direction"))) {
    const m = groupMetrics(ts);
    console.log(`  ${dir.padEnd(8)}: ${String(m.count).padStart(4)} trades  ${pct(m.wr)} win  ${r3(m.exp)} expectancy`);
  }
  console.log();

  console.log("$500 Portfolio  (1% risk = $5 per trade)");
  console.log(LN);
  console.log(`  Expected value per trade : ${usd(expect)}`);
  console.log(`  Total backtest P&L       : ${usd(totalPnl)}`);
  console.log(`  Max drawdown             : -$${(maxDD * 5).toFixed(2)}`);
  console.log();

  // ── 5. Save full trade list ───────────────────────────────────────────────
  const csvPath = `backtest_${FROM_ISO}_${TO_ISO}.csv`;
  const hdr = "Date,Symbol,Style,Direction,Score,Entry,SL,TP1,TP2,ATR,Outcome,PnL_R";
  const rows = trades.map(t =>
    [t.ts.slice(0, 16), t.symbol, t.style, t.direction, t.score,
     t.entry.toFixed(2), t.sl.toFixed(2), t.tp1.toFixed(2), t.tp2.toFixed(2),
     t.atr.toFixed(4), t.outcome, t.pnl.toFixed(2)].join(",")
  );
  writeFileSync(csvPath, [hdr, ...rows].join("\n"));
  console.log(`Full trade list → ${csvPath}`);
  console.log(`${HR}\n`);

  // ── 6. Interpretation guide ───────────────────────────────────────────────
  console.log("Interpretation");
  console.log(LN);
  console.log("  Expectancy > 0     — strategy has positive edge");
  console.log("  Expectancy > +0.3R — solid edge worth trading");
  console.log("  Profit factor > 1.5 — good");
  console.log("  Profit factor > 2.0 — excellent");
  console.log("  Sharpe > 1.0       — acceptable risk-adjusted return");
  console.log("  Sharpe > 2.0       — Goldman-level (quant fund threshold)");
  console.log("  Max drawdown > 10R — strategy too aggressive for $500");
  console.log("  Win rate alone means nothing — expectancy is what matters\n");
}

runBacktest().catch(err => { console.error("\nBacktest crashed:", err.message); process.exit(1); });

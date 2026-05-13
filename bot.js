/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a cron schedule. Pulls candle data from
 * BitGet (futures or spot), calculates indicators, scores confidence against
 * rules.json, and executes via BitGet if confidence >= 80.
 *
 * Local mode:  node bot.js
 * Cloud mode:  deploy to Railway — env vars set via `railway variables set`
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  // On Railway env vars are injected directly — no .env file exists
  const isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);

  if (!isCloud && !existsSync(".env")) {
    console.log("\n⚠️  No .env file found — creating one for you to fill in...\n");
    writeFileSync(".env", [
      "# BitGet credentials",
      "BITGET_API_KEY=",
      "BITGET_SECRET_KEY=",
      "BITGET_PASSPHRASE=",
      "",
      "# Trading config",
      "TRADE_MODE=futures",
      "PORTFOLIO_VALUE_USD=1000",
      "MAX_TRADE_SIZE_USD=100",
      "MAX_TRADES_PER_DAY=3",
      "MAX_LEVERAGE=3",
      "PAPER_TRADING=true",
      "SYMBOL=BTCUSDT",
      "TIMEFRAME=4H",
    ].join("\n") + "\n");
    try { execSync("open .env"); } catch {}
    console.log("Fill in your BitGet credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0 && !isCloud) {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
    try { execSync("open .env"); } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}\n`);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol:          process.env.SYMBOL               || "BTCUSDT",
  timeframe:       process.env.TIMEFRAME             || "4H",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY    || "3"),
  maxLeverage:     parseInt(process.env.MAX_LEVERAGE          || "3"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  tradeMode:       process.env.TRADE_MODE            || "futures",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Timezone helpers ─────────────────────────────────────────────────────────
function ptDate(date) {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
}
function ptTime(date) {
  return new Date(date).toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour12: false }); // HH:MM:SS
}
function ptDateTime(date) {
  return `${ptDate(date)} ${ptTime(date)} PT`;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  try { return JSON.parse(readFileSync(LOG_FILE, "utf8")); }
  catch { return { trades: [] }; }
}

function saveLog(log) {
  try { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
  catch (err) { console.log(`⚠️  Could not save log: ${err.message}`); }
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

// ─── Market Data (BitGet public API) ─────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Futures granularity: 1m 3m 5m 15m 30m 1H 4H 6H 12H 1D 1W
  // Spot granularity:    1min 3min 5min 15min 30min 1hour 4hour 1day 1week
  const futuresMap = {
    "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m",
    "1H":"1H","4H":"4H","6H":"6H","12H":"12H","1D":"1D","1W":"1W",
  };
  const spotMap = {
    "1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min",
    "1H":"1hour","4H":"4hour","6H":"6hour","12H":"12hour","1D":"1day","1W":"1week",
  };

  const clampedLimit = Math.min(limit, 100);
  const isFutures = CONFIG.tradeMode === "futures";
  const granularity = isFutures
    ? (futuresMap[interval] || "4H")
    : (spotMap[interval] || "4hour");

  const url = isFutures
    ? `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=usdt-futures&granularity=${granularity}&limit=${clampedLimit}`
    : `https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=${clampedLimit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`BitGet API HTTP error: ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(`BitGet API error: ${json.msg} (code: ${json.code})`);
  if (!json.data || json.data.length === 0) throw new Error("BitGet returned empty candle data");

  // BitGet candle format: [timestamp, open, high, low, close, baseVol, quoteVol]
  return json.data.map((k) => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ───────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = candles[i].high;
    const low   = candles[i].low;
    const prevClose = candles[i - 1].close;
    trValues.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  // Simple average of last `period` true ranges
  const slice = trValues.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;

  const multFast = 2 / (fast + 1);
  const multSlow = 2 / (slow + 1);
  const multSig  = 2 / (signal + 1);

  // Fast EMA: SMA-init over first `fast` bars, then incremental up to index `slow-1`
  let emaFast = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  for (let i = fast; i < slow; i++) emaFast = closes[i] * multFast + emaFast * (1 - multFast);

  // Slow EMA: SMA-init over first `slow` bars
  let emaSlow = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;

  // Build MACD series in a single O(n) pass
  const macdSeries = [];
  for (let i = slow; i < closes.length; i++) {
    emaFast = closes[i] * multFast + emaFast * (1 - multFast);
    emaSlow = closes[i] * multSlow + emaSlow * (1 - multSlow);
    macdSeries.push(emaFast - emaSlow);
  }
  if (macdSeries.length < signal) return null;

  // Signal line: EMA of MACD series
  let signalLine = macdSeries.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < macdSeries.length; i++) {
    signalLine = macdSeries[i] * multSig + signalLine * (1 - multSig);
  }

  const macdLine = macdSeries[macdSeries.length - 1];
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

// EMA crossover detection (looks at current and previous bar)
function detectCrossover(closes, fastPeriod, slowPeriod) {
  if (closes.length < Math.max(fastPeriod, slowPeriod) + 2) return "none";
  const fastNow  = calcEMA(closes, fastPeriod);
  const slowNow  = calcEMA(closes, slowPeriod);
  const fastPrev = calcEMA(closes.slice(0, -1), fastPeriod);
  const slowPrev = calcEMA(closes.slice(0, -1), slowPeriod);
  if (!fastNow || !slowNow || !fastPrev || !slowPrev) return "none";
  if (fastPrev <= slowPrev && fastNow > slowNow) return "bullish";
  if (fastPrev >= slowPrev && fastNow < slowNow) return "bearish";
  return fastNow > slowNow ? "above" : "below"; // already crossed in past
}

function volumeAboveMA(candles, period = 20, multiplier = 1.0) {
  // Use the most recently COMPLETED candle, not the current open one.
  // The bot runs at the top of each hour — the current candle has near-zero volume.
  if (candles.length < period + 2) return false;
  const recent = candles.slice(-period - 2, -2);
  const avg    = recent.reduce((s, c) => s + c.volume, 0) / period;
  const refVol = candles[candles.length - 2].volume;
  return refVol >= avg * multiplier;
}

function priceStructure(candles, lookback = 10) {
  if (candles.length < lookback * 2) return null;
  const recent = candles.slice(-lookback);
  const prior  = candles.slice(-lookback * 2, -lookback);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow  = Math.min(...recent.map((c) => c.low));
  const priorHigh  = Math.max(...prior.map((c) => c.high));
  const priorLow   = Math.min(...prior.map((c) => c.low));
  return {
    higherHigh: recentHigh > priorHigh,
    higherLow:  recentLow  > priorLow,
    lowerHigh:  recentHigh < priorHigh,
    lowerLow:   recentLow  < priorLow,
  };
}

function calcBollinger(closes, period = 20, sd = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, c) => s + (c - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { middle: mean, upper: mean + sd * std, lower: mean - sd * std, width: sd * 2 * std };
}

// Rolling VWAP over all available candles — avoids midnight null on 4H charts
function calcVWAP(candles) {
  if (!candles || candles.length === 0) return null;
  // Try session VWAP (midnight UTC reset) first
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  let sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  // Fall back to all candles if session is empty (e.g. exactly at midnight)
  if (sessionCandles.length === 0) sessionCandles = candles;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── SAFEGUARD: Macro Veto (Daily 200 EMA check) ─────────────────────────────
// Hard veto: if the bot wants to trade in a direction that conflicts with the
// daily macro trend, abort. This is the single biggest edge-preserving filter.

async function checkMacroVeto(symbol, direction) {
  try {
    console.log(`\n── Macro Veto Check (${symbol} Daily 200 EMA) ───────────\n`);
    const dailyCandles = await fetchCandles(symbol, "1D", 100);
    if (dailyCandles.length < 50) {
      console.log("⚠️  Not enough daily data for macro veto — aborting trade as a precaution");
      return { vetoed: true, reason: "Insufficient daily data" };
    }

    const dailyCloses = dailyCandles.map((c) => c.close);
    // Use highest available period up to 200
    const period = Math.min(200, dailyCloses.length - 1);
    const dailyEMA = calcEMA(dailyCloses, period);
    const dailyPrice = dailyCloses[dailyCloses.length - 1];

    console.log(`  Daily price       : $${dailyPrice.toFixed(2)}`);
    console.log(`  Daily ${period} EMA   : $${dailyEMA.toFixed(2)}`);

    const macroBullish = dailyPrice > dailyEMA;
    const macroBearish = dailyPrice < dailyEMA;

    if (direction === "long" && macroBearish) {
      console.log("🛑 MACRO VETO — long signal but daily macro is BEARISH. Trade aborted.");
      return { vetoed: true, reason: `Long against bearish macro (price $${dailyPrice.toFixed(2)} < daily EMA $${dailyEMA.toFixed(2)})` };
    }

    if (direction === "short" && macroBullish) {
      console.log("🛑 MACRO VETO — short signal but daily macro is BULLISH. Trade aborted.");
      return { vetoed: true, reason: `Short against bullish macro (price $${dailyPrice.toFixed(2)} > daily EMA $${dailyEMA.toFixed(2)})` };
    }

    console.log(`✅ MACRO ALIGNED — ${direction} setup matches daily ${macroBullish ? "bullish" : "bearish"} macro`);
    return { vetoed: false, dailyPrice, dailyEMA };
  } catch (err) {
    console.log(`⚠️  Macro veto check failed: ${err.message} — aborting trade as a precaution`);
    return { vetoed: true, reason: `Macro check error: ${err.message}` };
  }
}

// ─── Confidence Scoring — Multi-Style (matches rules.json) ───────────────────
// Each style has 10 conditions, each worth 10 pts. Score >= 80 qualifies.
// Each scorer returns { score, conditions, atr (primary TF), price, style }.

// SCALP: 5m primary, 15m confirmation
function scoreScalp(c5m, c15m, vwap, direction) {
  const closes5m  = c5m.map((c) => c.close);
  const closes15m = c15m.map((c) => c.close);
  const price     = closes5m[closes5m.length - 1];

  const ema9_5m   = calcEMA(closes5m, 9);
  const ema21_5m  = calcEMA(closes5m, 21);
  const rsi7_5m   = calcRSI(closes5m, 7);
  const macd_5m   = calcMACD(closes5m, 6, 13, 5);
  const ema200_15m = calcEMA(closes15m, Math.min(200, closes15m.length - 1));
  const rsi14_15m  = calcRSI(closes15m, 14);
  const last15m    = c15m[c15m.length - 1];
  const struct5m   = priceStructure(c5m, 5);
  const cross      = detectCrossover(closes5m, 9, 21);
  const volOK      = volumeAboveMA(c5m, 20, 1.5);
  const atr7_5m    = calcATR(c5m, 7);

  const conditions = [];
  const check = (label, pass) => conditions.push({ label, pass: !!pass });

  if (direction === "long") {
    check("Price above VWAP (session bias bullish)",        vwap && price > vwap);
    check("Price above 200 EMA on 15m chart",               ema200_15m && price > ema200_15m);
    check("EMA 9 ≥ EMA 21 on 5m (recent or current)",       cross === "bullish" || cross === "above");
    check("RSI(7) below 20 on 5m (oversold)",               rsi7_5m !== null && rsi7_5m < 20);
    check("MACD(6/13/5) histogram positive on 5m",          macd_5m && macd_5m.histogram > 0);
    check("Volume ≥ 1.5x 20-period MA on 5m",               volOK);
    check("15m candle closed bullish (green)",              last15m && last15m.close > last15m.open);
    check("Higher low on 5m chart",                          struct5m && struct5m.higherLow);
    check("Price > EMA 9 on 5m (micro uptrend)",            ema9_5m && price > ema9_5m);
    check("15m RSI(14) above 50",                            rsi14_15m !== null && rsi14_15m > 50);
  } else {
    check("Price below VWAP (session bias bearish)",        vwap && price < vwap);
    check("Price below 200 EMA on 15m chart",               ema200_15m && price < ema200_15m);
    check("EMA 9 ≤ EMA 21 on 5m (recent or current)",       cross === "bearish" || cross === "below");
    check("RSI(7) above 80 on 5m (overbought)",             rsi7_5m !== null && rsi7_5m > 80);
    check("MACD(6/13/5) histogram negative on 5m",          macd_5m && macd_5m.histogram < 0);
    check("Volume ≥ 1.5x 20-period MA on 5m",               volOK);
    check("15m candle closed bearish (red)",                last15m && last15m.close < last15m.open);
    check("Lower high on 5m chart",                          struct5m && struct5m.lowerHigh);
    check("Price < EMA 9 on 5m (micro downtrend)",          ema9_5m && price < ema9_5m);
    check("15m RSI(14) below 50",                            rsi14_15m !== null && rsi14_15m < 50);
  }

  return {
    score:      conditions.filter((c) => c.pass).length * 10,
    conditions, atr: atr7_5m, price, style: "scalp",
  };
}

// DAY TRADE: 1H primary, 4H confirmation
function scoreDayTrade(c1h, c4h, direction) {
  const closes1h = c1h.map((c) => c.close);
  const closes4h = c4h.map((c) => c.close);
  const price    = closes1h[closes1h.length - 1];

  const ema21_1h  = calcEMA(closes1h, 21);
  const ema55_1h  = calcEMA(closes1h, 55);
  const rsi14_1h  = calcRSI(closes1h, 14);
  const macd_1h   = calcMACD(closes1h);
  const ema200_4h = calcEMA(closes4h, Math.min(200, closes4h.length - 1));
  const rsi14_4h  = calcRSI(closes4h, 14);
  const ema21_4h  = calcEMA(closes4h, 21);
  const ema55_4h  = calcEMA(closes4h, 55);
  const last4h    = c4h[c4h.length - 1];
  const struct1h  = priceStructure(c1h, 8);
  const cross1h   = detectCrossover(closes1h, 21, 55);
  const volOK     = volumeAboveMA(c1h, 20, 1.0);
  const atr14_1h  = calcATR(c1h, 14);

  const conditions = [];
  const check = (label, pass) => conditions.push({ label, pass: !!pass });

  if (direction === "long") {
    check("Price above 200 EMA on 4H (macro bullish)",      ema200_4h && price > ema200_4h);
    check("EMA 21 ≥ EMA 55 on 1H",                          cross1h === "bullish" || cross1h === "above");
    check("RSI(14) below 30 on 1H (oversold-ish)",          rsi14_1h !== null && rsi14_1h < 30);
    check("MACD histogram positive on 1H",                  macd_1h && macd_1h.histogram > 0);
    check("Volume above 20-period MA on 1H",                volOK);
    check("4H candle closed bullish",                        last4h && last4h.close > last4h.open);
    check("Higher high and higher low on 1H",                struct1h && struct1h.higherHigh && struct1h.higherLow);
    check("Price above EMA 21 on 1H",                        ema21_1h && price > ema21_1h);
    check("4H RSI(14) above 50",                             rsi14_4h !== null && rsi14_4h > 50);
    check("EMA 21 above EMA 55 on 4H",                       ema21_4h && ema55_4h && ema21_4h > ema55_4h);
  } else {
    check("Price below 200 EMA on 4H (macro bearish)",      ema200_4h && price < ema200_4h);
    check("EMA 21 ≤ EMA 55 on 1H",                          cross1h === "bearish" || cross1h === "below");
    check("RSI(14) above 70 on 1H (overbought-ish)",        rsi14_1h !== null && rsi14_1h > 70);
    check("MACD histogram negative on 1H",                  macd_1h && macd_1h.histogram < 0);
    check("Volume above 20-period MA on 1H",                volOK);
    check("4H candle closed bearish",                        last4h && last4h.close < last4h.open);
    check("Lower high and lower low on 1H",                  struct1h && struct1h.lowerHigh && struct1h.lowerLow);
    check("Price below EMA 21 on 1H",                        ema21_1h && price < ema21_1h);
    check("4H RSI(14) below 50",                             rsi14_4h !== null && rsi14_4h < 50);
    check("EMA 21 below EMA 55 on 4H",                       ema21_4h && ema55_4h && ema21_4h < ema55_4h);
  }

  return {
    score:      conditions.filter((c) => c.pass).length * 10,
    conditions, atr: atr14_1h, price, style: "day_trade",
  };
}

// SWING: 4H primary, 1D confirmation
function scoreSwing(c4h, c1d, direction) {
  const closes4h = c4h.map((c) => c.close);
  const closes1d = c1d.map((c) => c.close);
  const price    = closes4h[closes4h.length - 1];

  const ema21_4h   = calcEMA(closes4h, 21);
  const ema55_4h   = calcEMA(closes4h, 55);
  const rsi14_4h   = calcRSI(closes4h, 14);
  const macd_4h    = calcMACD(closes4h);
  const bb_4h      = calcBollinger(closes4h, 20, 2);
  const ema200_1d  = calcEMA(closes1d, Math.min(200, closes1d.length - 1));
  const ema21_1d   = calcEMA(closes1d, 21);
  const ema55_1d   = calcEMA(closes1d, 55);
  const last1d     = c1d[c1d.length - 1];
  const prev1d     = c1d[c1d.length - 2];
  const struct4h   = priceStructure(c4h, 8);
  const cross4h    = detectCrossover(closes4h, 21, 55);
  const volOK      = volumeAboveMA(c4h, 20, 1.0);
  const atr14_4h   = calcATR(c4h, 14);

  const conditions = [];
  const check = (label, pass) => conditions.push({ label, pass: !!pass });

  if (direction === "long") {
    check("Price above 200 EMA on Daily (macro bull)",      ema200_1d && price > ema200_1d);
    check("EMA 21 ≥ EMA 55 on 4H",                          cross4h === "bullish" || cross4h === "above");
    check("RSI(14) below 30 on 4H (pullback in trend)",    rsi14_4h !== null && rsi14_4h < 30);
    check("MACD histogram positive on 4H",                  macd_4h && macd_4h.histogram > 0);
    check("Volume above 20-period MA on 4H",                volOK);
    check("Bollinger upper band breached or squeeze release", bb_4h && price > bb_4h.upper);
    check("Higher high and higher low on 4H",                struct4h && struct4h.higherHigh && struct4h.higherLow);
    check("Price above EMA 21 on 4H",                        ema21_4h && price > ema21_4h);
    check("Daily candle closed above prior day's high",      last1d && prev1d && last1d.close > prev1d.high);
    check("EMA 21 above EMA 55 on Daily",                    ema21_1d && ema55_1d && ema21_1d > ema55_1d);
  } else {
    check("Price below 200 EMA on Daily (macro bear)",      ema200_1d && price < ema200_1d);
    check("EMA 21 ≤ EMA 55 on 4H",                          cross4h === "bearish" || cross4h === "below");
    check("RSI(14) above 70 on 4H (rally in downtrend)",   rsi14_4h !== null && rsi14_4h > 70);
    check("MACD histogram negative on 4H",                  macd_4h && macd_4h.histogram < 0);
    check("Volume above 20-period MA on 4H",                volOK);
    check("Bollinger lower band breached or squeeze release", bb_4h && price < bb_4h.lower);
    check("Lower high and lower low on 4H",                  struct4h && struct4h.lowerHigh && struct4h.lowerLow);
    check("Price below EMA 21 on 4H",                        ema21_4h && price < ema21_4h);
    check("Daily candle closed below prior day's low",       last1d && prev1d && last1d.close < prev1d.low);
    check("EMA 21 below EMA 55 on Daily",                    ema21_1d && ema55_1d && ema21_1d < ema55_1d);
  }

  return {
    score:      conditions.filter((c) => c.pass).length * 10,
    conditions, atr: atr14_4h, price, style: "swing",
  };
}

// ─── Trade Limits ─────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
  const todayCount = countTodaysTrades(log);

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);

  // Risk 1.5% of portfolio, capped at maxTradeSizeUSD
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.015, CONFIG.maxTradeSizeUSD);
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`);
  return true;
}

// ─── BitGet Execution ─────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${timestamp}${method}${path}${body}`)
    .digest("base64");
}

async function setFuturesLeverage(symbol, leverage) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/mix/account/set-leverage";
  const body = JSON.stringify({
    symbol,
    productType: "usdt-futures",
    marginCoin: "USDT",
    leverage: String(leverage),
    holdSide: "long_short",
  });
  const sig = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });
  const data = await res.json();
  if (data.code !== "00000") {
    console.log(`⚠️  Leverage set warning: ${data.msg}`);
  } else {
    console.log(`✅ Leverage set to ${leverage}x`);
  }
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, leverage = 1) {
  const timestamp = Date.now().toString();

  if (CONFIG.tradeMode === "futures") {
    // Futures: size is in contracts. For BTCUSDT each contract = 0.001 BTC
    const contractSize = 0.001;
    const btcAmount = sizeUSD / price;
    const contracts = Math.floor(btcAmount / contractSize);
    if (contracts < 1) throw new Error(`Trade size $${sizeUSD} too small for 1 contract at $${price}`);

    const path = "/api/v2/mix/order/placeOrder";
    const body = JSON.stringify({
      symbol,
      productType: "usdt-futures",
      marginMode: "isolated",
      marginCoin: "USDT",
      size: String(contracts),
      side: side === "buy" ? "buy" : "sell",
      tradeSide: side === "buy" ? "open" : "open",
      orderType: "market",
    });
    const sig = signBitGet(timestamp, "POST", path, body);
    const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ACCESS-KEY": CONFIG.bitget.apiKey,
        "ACCESS-SIGN": sig,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
      },
      body,
    });
    const data = await res.json();
    if (data.code !== "00000") throw new Error(`BitGet futures order failed: ${data.msg}`);
    return data.data;

  } else {
    // Spot
    const quantity = (sizeUSD / price).toFixed(6);
    const path = "/api/v2/spot/trade/placeOrder";
    const body = JSON.stringify({ symbol, side, orderType: "market", quantity });
    const sig = signBitGet(timestamp, "POST", path, body);
    const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ACCESS-KEY": CONFIG.bitget.apiKey,
        "ACCESS-SIGN": sig,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
      },
      body,
    });
    const data = await res.json();
    if (data.code !== "00000") throw new Error(`BitGet spot order failed: ${data.msg}`);
    return data.data;
  }
}

// ─── BitGet TP/SL Orders ──────────────────────────────────────────────────────
// Places separate take-profit and stop-loss trigger orders after an entry.
// BitGet endpoint: /api/v2/mix/order/placeTpslOrder
// planType: "pos_profit" = take profit  |  "pos_loss" = stop loss

async function placeTpslOrder(symbol, holdSide, planType, triggerPrice, size) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/mix/order/placeTpslOrder";
  const body = JSON.stringify({
    symbol,
    productType:  "usdt-futures",
    marginMode:   "isolated",
    marginCoin:   "USDT",
    planType,
    triggerPrice: triggerPrice.toFixed(2),
    triggerType:  "mark_price",
    holdSide,
    size:         size !== undefined ? String(size) : undefined,
    // size omitted → closes the whole position (used for SL and full-exit TP)
  });
  const sig = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "ACCESS-KEY":        CONFIG.bitget.apiKey,
      "ACCESS-SIGN":       sig,
      "ACCESS-TIMESTAMP":  timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`TP/SL order failed (${planType}): ${data.msg}`);
  return data.data;
}

// Compute SL / TP1 / TP2 prices from ATR, return as a structured object.
// Rules (from rules.json):
//   SL:  1.5 × ATR  below entry (long)  / above entry (short)
//   TP1: 2.25 × ATR above entry (long)  / below entry (short)  → close 50%
//   TP2: 4.5 × ATR  above entry (long)  / below entry (short)  → close remaining 50%
function computeLevels(direction, entryPrice, atr) {
  const sl_mult  = 1.5;
  const tp1_mult = 2.25;
  const tp2_mult = 4.5;

  if (direction === "long") {
    return {
      stopLoss:    entryPrice - sl_mult  * atr,
      takeProfit1: entryPrice + tp1_mult * atr,
      takeProfit2: entryPrice + tp2_mult * atr,
      atr,
    };
  } else {
    return {
      stopLoss:    entryPrice + sl_mult  * atr,
      takeProfit1: entryPrice - tp1_mult * atr,
      takeProfit2: entryPrice - tp2_mult * atr,
      atr,
    };
  }
}

// ─── Open Position Check (BitGet) ─────────────────────────────────────────────
// Returns array of currently-open positions with non-zero size.
async function getOpenPositions() {
  const timestamp = Date.now().toString();
  const path = "/api/v2/mix/position/all-position?productType=usdt-futures&marginCoin=USDT";
  const sig = signBitGet(timestamp, "GET", path, "");
  try {
    const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
      headers: {
        "ACCESS-KEY":        CONFIG.bitget.apiKey,
        "ACCESS-SIGN":       sig,
        "ACCESS-TIMESTAMP":  timestamp,
        "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
      },
    });
    const data = await res.json();
    if (data.code !== "00000") {
      console.log(`⚠️  Position check warning: ${data.msg} — proceeding cautiously`);
      return [];
    }
    return (data.data || []).filter((p) => parseFloat(p.total || 0) > 0);
  } catch (err) {
    console.log(`⚠️  Position check failed: ${err.message}`);
    return [];
  }
}

// ─── Funding Rate (BitGet) ────────────────────────────────────────────────────
// Returns the current 8-hour funding rate as a decimal.
// > 0  = longs pay shorts. < 0 = shorts pay longs.
async function getFundingRate(symbol) {
  const url = `${CONFIG.bitget.baseUrl}/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=usdt-futures`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.code !== "00000") return 0;
    const rec = Array.isArray(data.data) ? data.data[0] : data.data;
    return parseFloat(rec?.fundingRate ?? 0);
  } catch {
    return 0;
  }
}

// ─── Symbol Scanner ───────────────────────────────────────────────────────────
// For one symbol: fetch all needed timeframes, score all 3 styles × 2 directions,
// apply funding-rate penalty, return all 6 setups.
async function scanSymbol(symbol) {
  console.log(`\n── Scanning ${symbol} ─────────────────────────────────\n`);

  // Fetch in parallel for speed
  const [c5m, c15m, c1h, c4h, c1d, funding] = await Promise.all([
    fetchCandles(symbol, "5m",  100),
    fetchCandles(symbol, "15m", 100),
    fetchCandles(symbol, "1H",  100),
    fetchCandles(symbol, "4H",  100),
    fetchCandles(symbol, "1D",  100),
    getFundingRate(symbol),
  ]);

  const vwap = calcVWAP(c5m);
  console.log(`  Funding rate (8h): ${(funding * 100).toFixed(4)}%`);

  const setups = [
    { ...scoreScalp(c5m, c15m, vwap, "long"),   direction: "long"  },
    { ...scoreScalp(c5m, c15m, vwap, "short"),  direction: "short" },
    { ...scoreDayTrade(c1h, c4h, "long"),       direction: "long"  },
    { ...scoreDayTrade(c1h, c4h, "short"),      direction: "short" },
    { ...scoreSwing(c4h, c1d, "long"),          direction: "long"  },
    { ...scoreSwing(c4h, c1d, "short"),         direction: "short" },
  ];

  // Funding penalty: if you'd be paying >0.05% per 8h, deduct 10 pts
  const FUNDING_THRESHOLD = 0.0005;
  for (const s of setups) {
    s.symbol = symbol;
    s.funding = funding;
    s.fundingPenalty = false;
    if (s.direction === "long"  && funding >  FUNDING_THRESHOLD) { s.score -= 10; s.fundingPenalty = true; }
    if (s.direction === "short" && funding < -FUNDING_THRESHOLD) { s.score -= 10; s.fundingPenalty = true; }
  }

  // Log the best setup per style for transparency
  const styles = ["scalp", "day_trade", "swing"];
  for (const st of styles) {
    const best = setups.filter((s) => s.style === st)
                       .reduce((a, b) => (a.score >= b.score ? a : b));
    const fp = best.fundingPenalty ? " (−10 funding)" : "";
    console.log(`  ${st.padEnd(10)} best: ${best.direction.toUpperCase().padEnd(5)} ${best.score}/100${fp}`);
  }

  return setups;
}

// Confidence-based leverage selector (per rules.json)
function leverageForStyle(style, score) {
  const styleMax = { scalp: 3, day_trade: 2, swing: 1 }[style] ?? 1;
  // Score of exactly 80 → use lower leverage; 90+ → full
  const reduced = score < 90 ? Math.max(1, styleMax - 1) : styleMax;
  return Math.min(reduced, CONFIG.maxLeverage);
}

// ─── Tax CSV ──────────────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date (PT)","Time (PT)","Exchange","Symbol","Side","Quantity",
  "Price","Total USD","Fee (est.)","Net Amount","ATR","Stop Loss","TP1","TP2","Order ID","Mode","Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
  }
}

function writeTradeCsv(logEntry) {
  const date = ptDate(logEntry.timestamp);
  const time = ptTime(logEntry.timestamp);

  const lvl = logEntry.levels || {};
  const atrVal = lvl.atr        ? lvl.atr.toFixed(2)         : "";
  const sl     = lvl.stopLoss   ? lvl.stopLoss.toFixed(2)    : "";
  const tp1    = lvl.takeProfit1? lvl.takeProfit1.toFixed(2) : "";
  const tp2    = lvl.takeProfit2? lvl.takeProfit2.toFixed(2) : "";

  let side = "", quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = logEntry.vetoed ? "VETOED" : "BLOCKED";
    orderId = mode;
    // VETOED: show hypothetical levels + veto reason; BLOCKED: show which conditions failed
    if (logEntry.vetoed) {
      notes = `Veto: ${logEntry.vetoReason}` +
              (sl ? ` | Hypothetical SL $${sl} TP1 $${tp1} TP2 $${tp2}` : "");
    } else {
      notes = `Failed: ${failed}`;
    }
  } else if (logEntry.paperTrading) {
    side      = logEntry.direction === "short" ? "SELL" : "BUY";
    quantity  = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD  = logEntry.tradeSize.toFixed(2);
    fee       = (logEntry.tradeSize * 0.0006).toFixed(4); // BitGet futures taker fee ~0.06%
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId   = logEntry.orderId || "";
    mode      = "PAPER";
    notes     = `All conditions met | ${logEntry.leverage}x | SL $${sl} | TP1 $${tp1} | TP2 $${tp2}`;
  } else {
    side      = logEntry.direction === "short" ? "SELL" : "BUY";
    quantity  = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD  = logEntry.tradeSize.toFixed(2);
    fee       = (logEntry.tradeSize * 0.0006).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId   = logEntry.orderId || "";
    mode      = "LIVE";
    notes     = logEntry.error
      ? `Error: ${logEntry.error}`
      : `All conditions met | ${logEntry.leverage}x | SL $${sl} | TP1 $${tp1} | TP2 $${tp2}`;
  }

  const row = [date, time, "BitGet", logEntry.symbol, side, quantity,
    logEntry.price.toFixed(2), totalUSD, fee, netAmount,
    atrVal, sl, tp1, tp2, orderId, mode, `"${notes}"`].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found yet."); return; }
  const rows = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  // Mode column is index 15 (Date,Time,Exchange,Symbol,Side,Qty,Price,USD,Fee,Net,ATR,SL,TP1,TP2,OrderID,Mode,Notes)
  const MODE_COL = 15;
  const live    = rows.filter((r) => r[MODE_COL] === "LIVE");
  const paper   = rows.filter((r) => r[MODE_COL] === "PAPER");
  const blocked = rows.filter((r) => r[MODE_COL] === "BLOCKED");
  const totalVolume = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees   = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log(`\n── Tax Summary ──────────────────────────────────────────`);
  console.log(`  Total decisions    : ${rows.length}`);
  console.log(`  Live trades        : ${live.length}`);
  console.log(`  Paper trades       : ${paper.length}`);
  console.log(`  Blocked            : ${blocked.length}`);
  console.log(`  Total volume (USD) : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees (est.)  : $${totalFees.toFixed(4)}\n`);
}

// ─── Google Sheet Webhook ─────────────────────────────────────────────────────

async function logToGoogleSheet(logEntry, bias, conditionsPassed, conditionsFailed) {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp:       ptDateTime(logEntry.timestamp),
        symbol:          logEntry.symbol,
        timeframe:       logEntry.style || logEntry.timeframe,
        price:           logEntry.price,
        bias,
        style:           logEntry.style || "n/a",
        confidence:      `${logEntry.score}/100`,
        allPass:         logEntry.allPass,
        tradeSize:       logEntry.tradeSize,
        leverage:        `${logEntry.leverage}x`,
        paperTrading:    logEntry.paperTrading,
        atr:             logEntry.levels?.atr?.toFixed(2) ?? "",
        stopLoss:        logEntry.levels?.stopLoss?.toFixed(2) ?? "",
        takeProfit1:     logEntry.levels?.takeProfit1?.toFixed(2) ?? "",
        takeProfit2:     logEntry.levels?.takeProfit2?.toFixed(2) ?? "",
        conditionsPassed,
        conditionsFailed,
        notes: logEntry.vetoed
          ? `🛑 MACRO VETO: ${logEntry.vetoReason}`
          : logEntry.allPass
            ? `All conditions met | ${logEntry.leverage}x | ${logEntry.direction} | SL ${logEntry.levels?.stopLoss?.toFixed(2)} | TP1 ${logEntry.levels?.takeProfit1?.toFixed(2)} | TP2 ${logEntry.levels?.takeProfit2?.toFixed(2)}`
            : `Blocked: score ${logEntry.score}/100`,
      }),
    });
    console.log("📊 Decision logged to Google Sheet");
  } catch (err) {
    console.log(`⚠️  Google Sheet log failed (non-critical): ${err.message}`);
  }
}

// ─── Paper Position Tracker ───────────────────────────────────────────────────
// In paper mode, BitGet has no real positions to check. Instead, we query the
// Google Sheet (via doGet on the same Apps Script URL) to find the last TRADE
// row, then check whether the current price has already crossed its SL or TP2.
// If the position is still open, no new trade is entered.
//
// Requires doGet to be added to the Google Apps Script — see README.

async function getPaperPosition() {
  const webhookUrl = process.env.GOOGLE_SHEET_STATUS_URL;
  if (!webhookUrl) return null; // no status URL configured → skip check

  try {
    const res = await fetch(webhookUrl); // GET triggers doGet
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error || !data.lastTrade) return null;

    const t = data.lastTrade;
    if (!t.symbol || t.sl === null || t.tp2 === null) return null;

    // Fetch current price for the open trade's symbol
    const candles = await fetchCandles(t.symbol, "1m", 5);
    const currentPrice = candles[candles.length - 1].close;

    const isLong = t.direction === "long";
    const hitSL  = isLong ? currentPrice <= t.sl  : currentPrice >= t.sl;
    const hitTP2 = isLong ? currentPrice >= t.tp2 : currentPrice <= t.tp2;

    if (hitSL || hitTP2) {
      const reason = hitSL ? `SL hit ($${t.sl})` : `TP2 hit ($${t.tp2})`;
      console.log(`📊 Last paper trade (${t.symbol} ${t.direction} @ $${t.price}) is CLOSED — ${reason} | current $${currentPrice.toFixed(2)}`);
      return null; // position is closed — allow new entry
    }

    console.log(`🔵 Open paper position: ${t.symbol} ${t.direction.toUpperCase()} @ $${t.price}`);
    console.log(`   Current $${currentPrice.toFixed(2)} | SL $${t.sl} | TP2 $${t.tp2} — still active`);
    return t;

  } catch (err) {
    // If doGet isn't deployed yet, the call fails — allow trade (fail open)
    console.log(`⚠️  Paper position check unavailable: ${err.message} — proceeding without stacking guard`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${ptDateTime(new Date())}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Exchange mode: ${CONFIG.tradeMode.toUpperCase()}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlist = rules.watchlist || ["BTCUSDT"];
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.join(", ")}`);

  const log = loadLog();

  // SAFEGUARD: Open position check — bot does not stack positions
  console.log("\n── Open Position Check ──────────────────────────────────\n");
  if (CONFIG.paperTrading) {
    const paperPos = await getPaperPosition();
    if (paperPos) {
      console.log(`🛑 Open paper position on ${paperPos.symbol} — waiting for SL/TP2 to close.`);
      console.log("Paper bot does not stack positions — exiting this run.");
      return;
    }
    console.log("✅ No open paper position — clear to scan");
  } else {
    const open = await getOpenPositions();
    if (open.length > 0) {
      console.log(`🛑 Open position detected on ${open[0].symbol} (size ${open[0].total})`);
      console.log("Bot does not stack positions — exiting until current trade closes.");
      return;
    }
    console.log("✅ No open positions — clear to scan");
  }

  if (!checkTradeLimits(log)) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Scan all symbols, collect all setups
  const CONFIDENCE_THRESHOLD = rules.confidence_threshold?.minimum_to_trade ?? 80;
  const allSetups = [];
  for (const symbol of watchlist) {
    try {
      const setups = await scanSymbol(symbol);
      allSetups.push(...setups);
    } catch (err) {
      console.log(`⚠️  ${symbol} scan failed: ${err.message} — skipping`);
    }
  }

  // Filter to qualifying (>= threshold) and pick the best one
  const qualifying = allSetups.filter((s) => s.score >= CONFIDENCE_THRESHOLD);

  // Tiebreaker: if within 5 pts, prefer higher timeframe (swing > day_trade > scalp)
  const styleRank = { swing: 0, day_trade: 1, scalp: 2 };
  qualifying.sort((a, b) => {
    if (Math.abs(a.score - b.score) <= 5) return styleRank[a.style] - styleRank[b.style];
    return b.score - a.score;
  });

  const chosen = qualifying[0] || null;
  const allPass = !!chosen;

  // Best non-qualifying setup — used for logging when no trade fires
  const topByScore = allSetups.length
    ? [...allSetups].sort((a, b) => b.score - a.score)[0]
    : null;
  const reference = chosen ?? topByScore; // whichever is available

  console.log("\n── Final Decision ───────────────────────────────────────\n");

  if (!allPass) {
    console.log(`🚫 NO TRADE — no setup ≥ ${CONFIDENCE_THRESHOLD}`);
    if (topByScore) {
      console.log(`   Best non-qualifying: ${topByScore.symbol} ${topByScore.style} ${topByScore.direction.toUpperCase()} ${topByScore.score}/100`);
      topByScore.conditions.forEach((c) => console.log(`  ${c.pass ? "✅" : "🚫"} ${c.label}`));
    }
  } else {
    console.log(`✅ ${chosen.symbol} ${chosen.style.toUpperCase()} ${chosen.direction.toUpperCase()} — ${chosen.score}/100`);
    chosen.conditions.forEach((c) => console.log(`  ${c.pass ? "✅" : "🚫"} ${c.label}`));
  }

  // Trade size & leverage (confidence-scaled)
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.015, CONFIG.maxTradeSizeUSD);
  const leverage  = chosen ? leverageForStyle(chosen.style, chosen.score) : 1;

  const direction = reference?.direction ?? null;
  const symbol    = reference?.symbol    ?? watchlist[0];
  const price     = reference?.price     ?? null;
  const atr       = reference?.atr       ?? null;

  const logEntry = {
    timestamp:    new Date().toISOString(),
    symbol,
    timeframe:    reference?.style ?? "n/a",
    price:        price ?? 0,
    direction,
    style:        reference?.style ?? null,
    score:        reference?.score ?? 0,
    funding:      reference?.funding ?? 0,
    fundingPenalty: reference?.fundingPenalty ?? false,
    // For BLOCKED: log the best setup's failing conditions so the log is informative
    conditions:   reference?.conditions ?? [],
    allPass,
    tradeSize,
    leverage,
    orderPlaced:  false,
    orderId:      null,
    paperTrading: CONFIG.paperTrading,
  };

  if (allPass) {
    // SAFEGUARD: Macro veto check before any trade (paper or live)
    const macroCheck = await checkMacroVeto(symbol, direction);
    logEntry.macroCheck = macroCheck;

    if (macroCheck.vetoed) {
      console.log(`\n🛑 TRADE VETOED — ${macroCheck.reason}`);
      // Still compute hypothetical levels so the log shows what would have been
      if (atr && price) {
        const hypothetical = computeLevels(direction, price, atr);
        logEntry.levels = hypothetical;
        console.log(`   Hypothetical SL $${hypothetical.stopLoss.toFixed(2)} | TP1 $${hypothetical.takeProfit1.toFixed(2)} | TP2 $${hypothetical.takeProfit2.toFixed(2)}`);
      }
      logEntry.allPass = false;
      logEntry.vetoed = true;
      logEntry.vetoReason = macroCheck.reason;
    } else {
      // Compute SL / TP levels from ATR (required before any order)
      if (!atr) {
        console.log(`\n🛑 TRADE ABORTED — ATR(14) could not be calculated (not enough candles)`);
        logEntry.allPass = false;
        logEntry.vetoed = true;
        logEntry.vetoReason = "ATR unavailable";
      } else {
        const levels = computeLevels(direction, price, atr);
        logEntry.levels = levels;

        console.log(`\n── SL / TP Levels (ATR = $${atr.toFixed(2)}) ──────────────\n`);
        console.log(`  Entry      : $${price.toFixed(2)}`);
        console.log(`  Stop Loss  : $${levels.stopLoss.toFixed(2)}  (1.5 × ATR below entry)`);
        console.log(`  TP1        : $${levels.takeProfit1.toFixed(2)}  (2.25 × ATR — close 50%, move stop to BE)`);
        console.log(`  TP2        : $${levels.takeProfit2.toFixed(2)}  (4.5 × ATR — close remaining 50%)`);

        if (CONFIG.paperTrading) {
          console.log(`\n📋 PAPER TRADE — ${chosen.style.toUpperCase()} ${direction.toUpperCase()} $${tradeSize.toFixed(2)} ${symbol} @ $${price.toFixed(2)} | ${leverage}x leverage`);
          console.log(`   SL $${levels.stopLoss.toFixed(2)} | TP1 $${levels.takeProfit1.toFixed(2)} | TP2 $${levels.takeProfit2.toFixed(2)}`);
          logEntry.orderPlaced = true;
          logEntry.orderId = `PAPER-${Date.now()}`;
        } else {
          console.log(`\n🔴 LIVE ORDER — ${chosen.style.toUpperCase()} ${direction.toUpperCase()} $${tradeSize.toFixed(2)} ${symbol} | ${leverage}x`);
          try {
            if (CONFIG.tradeMode === "futures") {
              await setFuturesLeverage(symbol, leverage);
            }
            const side  = direction === "long" ? "buy" : "sell";
            const order = await placeBitGetOrder(symbol, side, tradeSize, price, leverage);
            logEntry.orderPlaced = true;
            logEntry.orderId = order.orderId;
            console.log(`✅ ENTRY ORDER PLACED — ${order.orderId}`);

            // Place TP/SL orders immediately after entry
            if (CONFIG.tradeMode === "futures") {
              const holdSide = direction === "long" ? "long" : "short";
              try {
                await placeTpslOrder(symbol, holdSide, "pos_loss",   levels.stopLoss,    undefined);
                console.log(`✅ STOP LOSS SET  — $${levels.stopLoss.toFixed(2)}`);
              } catch (err) {
                console.log(`⚠️  SL order failed: ${err.message} — CLOSE MANUALLY`);
                logEntry.slError = err.message;
              }
              try {
                await placeTpslOrder(symbol, holdSide, "pos_profit", levels.takeProfit2, undefined);
                console.log(`✅ TAKE PROFIT SET — $${levels.takeProfit2.toFixed(2)} (TP2, full close)`);
                console.log(`   ℹ️  TP1 at $${levels.takeProfit1.toFixed(2)} must be managed manually (partial close + move SL to BE)`);
              } catch (err) {
                console.log(`⚠️  TP order failed: ${err.message} — monitor manually`);
                logEntry.tpError = err.message;
              }
            }
          } catch (err) {
            console.log(`❌ ORDER FAILED — ${err.message}`);
            logEntry.error = err.message;
          }
        }
      }
    }
  }

  // Persist log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  writeTradeCsv(logEntry);

  // Use reference (best setup found, qualifying or not) so BLOCKED entries
  // show which conditions passed/failed instead of blank dashes.
  const conds  = (chosen ?? reference)?.conditions ?? [];
  const passed = conds.filter((c) =>  c.pass).map((c) => c.label).join("; ");
  const failed = conds.filter((c) => !c.pass).map((c) => c.label).join("; ");
  const bias   = direction ?? "FLAT";
  await logToGoogleSheet(logEntry, bias, passed, failed);

  console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── SAFEGUARD: Validation Summary ────────────────────────────────────────────
// Reads safety-check-log.json and summarises recent decisions to verify the
// bot is behaving correctly before flipping to live trading.

function validationSummary() {
  if (!existsSync(LOG_FILE)) {
    console.log("No decision log found yet. Bot has not run.");
    return;
  }
  const log = JSON.parse(readFileSync(LOG_FILE, "utf8"));
  const trades = log.trades || [];
  if (trades.length === 0) {
    console.log("No decisions logged yet.");
    return;
  }

  // Last 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = trades.filter((t) => new Date(t.timestamp).getTime() >= cutoff);
  const allTime = trades;

  const summarise = (label, set) => {
    const blocked = set.filter((t) => !t.allPass);
    const tradesTaken = set.filter((t) => t.orderPlaced && !t.vetoed);
    const vetoed = set.filter((t) => t.vetoed);
    const longs  = tradesTaken.filter((t) => t.direction === "long");
    const shorts = tradesTaken.filter((t) => t.direction === "short");
    const avgScore = set.reduce((s, t) => s + (t.score || 0), 0) / (set.length || 1);

    console.log(`\n── ${label} (${set.length} runs) ──────────────────────────`);
    console.log(`  Trades fired   : ${tradesTaken.length} (${longs.length} long, ${shorts.length} short)`);
    console.log(`  Macro vetoed   : ${vetoed.length}`);
    console.log(`  Blocked (low conf): ${blocked.length - vetoed.length}`);
    console.log(`  Avg confidence : ${avgScore.toFixed(1)}/100`);

    // Sanity: every trade should align with macro
    const misaligned = tradesTaken.filter((t) =>
      t.macroCheck && t.macroCheck.dailyPrice && (
        (t.direction === "long"  && t.macroCheck.dailyPrice < t.macroCheck.dailyEMA) ||
        (t.direction === "short" && t.macroCheck.dailyPrice > t.macroCheck.dailyEMA)
      )
    );
    if (misaligned.length > 0) {
      console.log(`  🚨 MISALIGNED TRADES : ${misaligned.length} — investigate before going live!`);
    } else if (tradesTaken.length > 0) {
      console.log(`  ✅ All trades macro-aligned`);
    }
  };

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Validation Summary — Bot Behaviour Audit");
  console.log("═══════════════════════════════════════════════════════════");
  summarise("Last 24 hours", recent);
  summarise("All time",       allTime);

  console.log(`\nReadiness checklist before going live:`);
  const tradesFired = allTime.filter((t) => t.orderPlaced && !t.vetoed).length;
  const decisionCount = allTime.length;
  console.log(`  ${decisionCount >= 24 ? "✅" : "⏳"} 24+ decisions logged (${decisionCount}/24)`);
  console.log(`  ${tradesFired >= 1  ? "✅" : "⏳"} At least 1 setup detected (${tradesFired})`);
  console.log(`  ${allTime.every((t) => !t.error || t.error.startsWith("Macro")) ? "✅" : "🚨"} No unexpected errors\n`);
}

// ─── SAFEGUARD: Test Trade ────────────────────────────────────────────────────
// Manually fires ONE small live trade to verify the BitGet API works end-to-end
// before the bot is allowed to trade autonomously. Hardcoded $20, 1x leverage.
//
// Usage: node bot.js --test-trade long
//        node bot.js --test-trade short

async function testTrade(direction) {
  if (!["long", "short"].includes(direction)) {
    console.log("Usage: node bot.js --test-trade <long|short>");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  ⚠️  LIVE TEST TRADE MODE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  This will place a REAL $20 ${direction} order on BitGet.");
  console.log("  Hardcoded: $20 size, 1x leverage, market order.");
  console.log("  Purpose: verify API integration before automating.");
  console.log("═══════════════════════════════════════════════════════════\n");

  if (CONFIG.tradeMode !== "futures") {
    console.log("❌ TEST TRADE only supports futures mode. Set TRADE_MODE=futures.");
    process.exit(1);
  }

  // Fetch current price
  console.log("Fetching current price from BitGet...");
  const candles = await fetchCandles(CONFIG.symbol, "1m", 5);
  const price = candles[candles.length - 1].close;
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Macro veto applies even to test trades
  const macroCheck = await checkMacroVeto(CONFIG.symbol, direction);
  if (macroCheck.vetoed) {
    console.log(`\n🛑 TEST TRADE VETOED — ${macroCheck.reason}`);
    console.log("Try the opposite direction or wait for macro alignment.");
    process.exit(0);
  }

  // Confirmation gate — requires explicit env var to actually execute
  if (process.env.TEST_TRADE_CONFIRMED !== "yes") {
    console.log("\n🛡️  SAFETY GATE — set TEST_TRADE_CONFIRMED=yes in .env to execute.");
    console.log("    This prevents accidental live trades.");
    console.log(`\nDirection : ${direction.toUpperCase()}`);
    console.log(`Symbol    : ${CONFIG.symbol}`);
    console.log(`Size      : $20 (1x leverage)`);
    console.log(`Price     : $${price.toFixed(2)}`);
    console.log(`Macro     : ✅ Aligned\n`);
    console.log("To execute: TEST_TRADE_CONFIRMED=yes node bot.js --test-trade " + direction);
    process.exit(0);
  }

  console.log("\n🔴 EXECUTING LIVE TEST TRADE...\n");
  try {
    await setFuturesLeverage(CONFIG.symbol, 1);
    const side = direction === "long" ? "buy" : "sell";
    const order = await placeBitGetOrder(CONFIG.symbol, side, 20, price, 1);
    console.log(`\n✅ TEST TRADE PLACED — order ID: ${order.orderId}`);
    console.log(`Check BitGet → Order History to confirm.`);
    console.log(`Manually close the position once verified.`);
  } catch (err) {
    console.log(`\n❌ TEST TRADE FAILED — ${err.message}`);
    console.log(`\nThis means the BitGet API is not working end-to-end yet.`);
    console.log(`Do NOT enable live trading until this passes.`);
    process.exit(1);
  }
}

// ─── Backtest ─────────────────────────────────────────────────────────────────
// Walks historical 4H candles and simulates the day_trade strategy bar-by-bar.
// (Day trade chosen because it has the most signals at usable bar resolution.)
// Each entry: simulates SL / TP1 (close 50%, move stop to BE) / TP2 (close rest).
// Output: trades, win rate, avg return per trade, total return, max drawdown.
//
// Usage: node bot.js --backtest BTCUSDT 90
//        (symbol, days back)

async function fetchHistoricalCandles(symbol, granularity, days) {
  // BitGet returns max 100 candles per call. Paginate by endTime.
  const msPerBar = {
    "1m":60_000,"5m":300_000,"15m":900_000,"30m":1_800_000,
    "1H":3_600_000,"4H":14_400_000,"1D":86_400_000,
  }[granularity] || 14_400_000;
  const totalBars = Math.ceil((days * 86_400_000) / msPerBar);
  const calls     = Math.ceil(totalBars / 100);
  let endTime = Date.now();
  const all = [];

  for (let i = 0; i < calls; i++) {
    const url = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${symbol}&productType=usdt-futures&granularity=${granularity}&endTime=${endTime}&limit=100`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code !== "00000" || !json.data?.length) break;
    const batch = json.data.map((k) => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    // Be polite with the API
    await new Promise((r) => setTimeout(r, 150));
  }
  // Dedupe and sort ascending
  const seen = new Set();
  return all.filter((c) => !seen.has(c.time) && seen.add(c.time))
            .sort((a, b) => a.time - b.time);
}

async function runBacktest() {
  const symbol = process.argv[process.argv.indexOf("--backtest") + 1] || "BTCUSDT";
  const days   = parseInt(process.argv[process.argv.indexOf("--backtest") + 2] || "90");

  console.log(`\n═══ Backtest: ${symbol} | ${days} days | day_trade strategy ═══\n`);
  console.log("Fetching historical 1H and 4H candles from BitGet...");

  const c1h_full = await fetchHistoricalCandles(symbol, "1H", days);
  const c4h_full = await fetchHistoricalCandles(symbol, "4H", days);
  console.log(`Loaded ${c1h_full.length} × 1H bars, ${c4h_full.length} × 4H bars`);
  if (c1h_full.length < 200) {
    console.log("Not enough data — need at least 200 1H bars");
    return;
  }

  // For each 1H bar (after warmup), score, and if qualifying, simulate.
  const WARMUP = 60;
  const FEE_RATE = 0.0006;       // 0.06% per side, taker
  const RISK_PER_TRADE = 0.015;  // 1.5%
  const trades = [];
  let equity = 10000;             // starting equity unit
  const equityCurve = [equity];
  let inTrade = false;
  let openTrade = null;

  for (let i = WARMUP; i < c1h_full.length; i++) {
    const bar = c1h_full[i];

    // Manage open trade first: check if SL or TP hit on this bar
    if (inTrade && openTrade) {
      const t = openTrade;
      const hitSL = (t.direction === "long" && bar.low  <= t.sl) ||
                    (t.direction === "short" && bar.high >= t.sl);
      const hitTP1 = !t.tp1Hit && ((t.direction === "long" && bar.high >= t.tp1) ||
                                   (t.direction === "short" && bar.low  <= t.tp1));
      const hitTP2 = (t.direction === "long" && bar.high >= t.tp2) ||
                    (t.direction === "short" && bar.low  <= t.tp2);

      if (hitSL) {
        // Stop hit. If TP1 already realized, this is the BE exit on remaining 50%.
        const fillPrice    = t.sl;
        const dir          = t.direction === "long" ? 1 : -1;
        const remainingPct = t.tp1Hit ? 0.5 : 1.0;
        const exitPnL      = dir * (fillPrice - t.entry) / t.entry * remainingPct * t.notional
                             - 2 * FEE_RATE * t.notional * remainingPct;
        const totalPnL     = (t.tp1Pnl || 0) + exitPnL;
        equity += exitPnL;
        t.exitReason = t.tp1Hit ? "BE_after_TP1" : "SL";
        t.exit = fillPrice;
        t.pnl  = totalPnL;
        trades.push(t);
        inTrade = false; openTrade = null;
      } else if (hitTP2) {
        const fillPrice = t.tp2;
        const dir       = t.direction === "long" ? 1 : -1;
        // If TP1 wasn't hit on a prior bar, realize TP1 here too (rare path)
        let realizedTp1 = t.tp1Pnl || 0;
        if (!t.tp1Hit) {
          realizedTp1 = dir * (t.tp1 - t.entry) / t.entry * 0.5 * t.notional - FEE_RATE * t.notional;
          equity += realizedTp1;
        }
        const tp2Pnl   = dir * (fillPrice - t.entry) / t.entry * 0.5 * t.notional - FEE_RATE * t.notional;
        equity += tp2Pnl;
        t.exitReason = "TP2";
        t.exit = fillPrice;
        t.pnl  = realizedTp1 + tp2Pnl;
        trades.push(t);
        inTrade = false; openTrade = null;
      } else if (hitTP1) {
        // Realize half, move SL to entry (breakeven)
        const dir = t.direction === "long" ? 1 : -1;
        const tp1Pnl = dir * (t.tp1 - t.entry) / t.entry * 0.5 * t.notional - FEE_RATE * t.notional;
        equity += tp1Pnl;
        t.tp1Hit = true;
        t.tp1Pnl = tp1Pnl;
        t.sl = t.entry; // move stop to BE
      }
    }

    if (inTrade) { equityCurve.push(equity); continue; }

    // Build sliced 1H + matching 4H windows up to current 1H bar
    const c1h_slice = c1h_full.slice(0, i + 1);
    const cutoffTime = bar.time;
    const c4h_slice = c4h_full.filter((c) => c.time <= cutoffTime);
    if (c4h_slice.length < 60) { equityCurve.push(equity); continue; }

    const longRes  = scoreDayTrade(c1h_slice, c4h_slice, "long");
    const shortRes = scoreDayTrade(c1h_slice, c4h_slice, "short");
    const best = longRes.score >= shortRes.score ? longRes : shortRes;
    if (best.score < 80 || !best.atr) { equityCurve.push(equity); continue; }

    const direction = longRes.score >= shortRes.score ? "long" : "short";
    // Macro check: 1D EMA — approximate using c4h aggregated to daily
    // Pragmatic: skip macro check in backtest, but log the choice
    const entry = bar.close;
    const levels = computeLevels(direction, entry, best.atr);
    const notional = equity * RISK_PER_TRADE * 10; // approximate position notional with leverage

    openTrade = {
      time:      new Date(bar.time).toISOString(),
      direction,
      entry,
      sl:        levels.stopLoss,
      tp1:       levels.takeProfit1,
      tp2:       levels.takeProfit2,
      notional,
      tp1Hit:    false,
      score:     best.score,
    };
    inTrade = true;
    equityCurve.push(equity);
  }

  // Stats
  const wins   = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const peak = Math.max(...equityCurve);
  const maxDD = ((peak - Math.min(...equityCurve.slice(equityCurve.indexOf(peak)))) / peak) * 100;
  const totalReturn = ((equity - 10000) / 10000) * 100;

  // Expectancy per trade — the right metric for asymmetric R:R systems
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const rrRatio    = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  console.log(`\n── Backtest Results ─────────────────────────────────────`);
  console.log(`  Period           : ${days} days`);
  console.log(`  Total trades     : ${trades.length}`);
  console.log(`  Win rate         : ${(winRate * 100).toFixed(1)}%`);
  console.log(`  Wins / Losses    : ${wins.length} / ${losses.length}`);
  console.log(`  Avg win  ($)     : ${avgWin.toFixed(2)}`);
  console.log(`  Avg loss ($)     : ${avgLoss.toFixed(2)}`);
  console.log(`  Reward:Risk      : ${rrRatio.toFixed(2)} : 1`);
  console.log(`  Expectancy/trade : $${expectancy.toFixed(2)}`);
  console.log(`  Total PnL ($)    : ${totalPnL.toFixed(2)}`);
  console.log(`  Total return     : ${totalReturn.toFixed(2)}%`);
  console.log(`  Max drawdown     : ${maxDD.toFixed(2)}%`);
  console.log(`  Final equity     : $${equity.toFixed(2)}\n`);

  // Verdict — expectancy and R:R matter more than raw win rate for trend systems
  if (trades.length < 10) {
    console.log("⚠️  Too few trades to draw a conclusion. Strategy too restrictive — try a longer period or loosen conditions.");
  } else if (expectancy > 0 && totalReturn > 0) {
    console.log(`✅ Positive expectancy: $${expectancy.toFixed(2)} per trade with ${rrRatio.toFixed(2)}:1 R:R.`);
    console.log("   Real trading will face slippage, funding, and gap risk — expect ~30-50% of this.");
    console.log("   Validate forward before going live.");
  } else {
    console.log("🚨 Negative expectancy. Do NOT go live without revising conditions.");
  }
}

// ─── Entry Points ─────────────────────────────────────────────────────────────

const args = process.argv;

if (args.includes("--tax-summary")) {
  generateTaxSummary();
} else if (args.includes("--validate")) {
  validationSummary();
} else if (args.includes("--backtest")) {
  runBacktest().catch((err) => {
    console.error("Backtest error:", err.message);
    process.exit(1);
  });
} else if (args.includes("--test-trade")) {
  const direction = args[args.indexOf("--test-trade") + 1];
  testTrade(direction).catch((err) => {
    console.error("Test trade error:", err.message);
    process.exit(1);
  });
} else {
  run().catch((err) => {
    console.error("Bot error:", err.message);
    process.exit(1);
  });
}

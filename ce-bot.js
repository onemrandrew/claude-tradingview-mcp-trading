#!/usr/bin/env node
/**
 * ce-bot.js — Chandelier Exit Webhook Bot
 *
 * Listens for TradingView CE signal webhooks and executes trades on BitGet.
 * Strategy: Long when CE turns bullish, short when CE turns bearish.
 * Exit: On the next opposite CE signal (always in market, no fixed TP).
 *
 * Deploy as a separate Railway service (persistent HTTP server, not cron).
 *
 * TradingView alert message format:
 *   {"action":"buy",  "symbol":"BTCUSDT"}   ← CE flips bullish
 *   {"action":"sell", "symbol":"BTCUSDT"}   ← CE flips bearish
 *
 * Env vars (shared with bot.js):
 *   BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE
 *   PORTFOLIO_VALUE_USD  default 500
 *   MAX_TRADE_SIZE_USD   default 75
 *   PAPER_TRADING        default true  (set to false for live)
 *   CE_LEVERAGE          default 3
 *   CE_ATR_PERIOD        default 22
 *   CE_ATR_MULTIPLIER    default 3.0
 *   CE_TIMEFRAME         default 4H
 *   CE_WEBHOOK_SECRET    optional — TradingView sends this in X-Webhook-Secret header
 */

import { createServer } from "http";
import crypto from "crypto";
import "dotenv/config";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "75"),
  leverage:        parseInt(process.env.CE_LEVERAGE           || "3"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  webhookSecret:   process.env.CE_WEBHOOK_SECRET              || "",
  atrPeriod:       parseInt(process.env.CE_ATR_PERIOD         || "22"),
  atrMultiplier:   parseFloat(process.env.CE_ATR_MULTIPLIER   || "3.0"),
  timeframe:       process.env.CE_TIMEFRAME                   || "4H",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    "https://api.bitget.com",
  },
};

// Precision lookup per symbol (size increment, size decimals, price decimals)
const PRECISION = {
  BTCUSDT:  { inc: 0.0001, sizeDp: 4, priceDp: 1 },
  SOLUSDT:  { inc: 0.1,    sizeDp: 1, priceDp: 3 },
  HYPEUSDT: { inc: 0.01,   sizeDp: 2, priceDp: 3 },
};
const defaultPrecision = { inc: 0.01, sizeDp: 2, priceDp: 2 };

// ─── BitGet Auth ──────────────────────────────────────────────────────────────

function sign(ts, method, path, body = "") {
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${ts}${method}${path}${body}`)
    .digest("base64");
}

function headers(ts, method, path, body = "") {
  return {
    "Content-Type":      "application/json",
    "ACCESS-KEY":        CONFIG.bitget.apiKey,
    "ACCESS-SIGN":       sign(ts, method, path, body),
    "ACCESS-TIMESTAMP":  ts,
    "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
  };
}

// ─── BitGet API ───────────────────────────────────────────────────────────────

async function fetchCandles(symbol, granularity, limit = 300) {
  const path = `/api/v2/mix/market/candles?symbol=${symbol}&productType=usdt-futures&granularity=${granularity}&limit=${limit}`;
  const res  = await fetch(`${CONFIG.bitget.baseUrl}${path}`);
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`Candles: ${data.msg}`);
  return (data.data || [])
    .map(k => ({ time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }))
    .sort((a, b) => a.time - b.time);
}

async function getOpenPosition(symbol, holdSide) {
  const ts   = Date.now().toString();
  const path = `/api/v2/mix/position/single-position?symbol=${symbol}&productType=usdt-futures&marginCoin=USDT`;
  const res  = await fetch(`${CONFIG.bitget.baseUrl}${path}`, { headers: headers(ts, "GET", path) });
  const data = await res.json();
  if (data.code !== "00000") return null;
  const pos  = (Array.isArray(data.data) ? data.data : []).find(p => p.holdSide === holdSide && parseFloat(p.total) > 0);
  return pos ?? null;
}

async function closeAllPositions(symbol) {
  const ts   = Date.now().toString();
  const path = "/api/v2/mix/order/close-positions";
  const body = JSON.stringify({ symbol, productType: "usdt-futures" });
  const res  = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST", headers: headers(ts, "POST", path, body), body,
  });
  const data = await res.json();
  // code 43001 = no position to close — not an error
  if (data.code !== "00000" && data.code !== "43001") throw new Error(`Close failed: ${data.msg}`);
  return data;
}

async function setLeverage(symbol, leverage) {
  const ts   = Date.now().toString();
  const path = "/api/v2/mix/account/set-leverage";
  for (const holdSide of ["long", "short"]) {
    const body = JSON.stringify({ symbol, productType: "usdt-futures", marginCoin: "USDT", leverage: String(leverage), holdSide });
    const res  = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
      method: "POST", headers: headers(ts, "POST", path, body), body,
    });
    const data = await res.json();
    if (data.code !== "00000" && data.code !== "40919") throw new Error(`Leverage: ${data.msg}`);
  }
}

async function placeMarketOrder(symbol, side, qty) {
  const ts  = Date.now().toString();
  const path = "/api/v2/mix/order/place-order";
  const p   = PRECISION[symbol] ?? defaultPrecision;
  const size = (Math.floor(qty / p.inc) * p.inc).toFixed(p.sizeDp);
  const body = JSON.stringify({
    symbol, productType: "usdt-futures", marginMode: "isolated",
    marginCoin: "USDT", size, side, tradeSide: "open", orderType: "market",
  });
  const res  = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST", headers: headers(ts, "POST", path, body), body,
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`Order: ${data.msg}`);
  return data.data;
}

async function placeSL(symbol, holdSide, slPrice) {
  const ts   = Date.now().toString();
  const path = "/api/v2/mix/order/place-tpsl-order";
  const p    = PRECISION[symbol] ?? defaultPrecision;
  const body = JSON.stringify({
    symbol, productType: "usdt-futures", marginCoin: "USDT",
    planType: "pos_loss", triggerPrice: slPrice.toFixed(p.priceDp),
    triggerType: "mark_price", holdSide,
  });
  const res  = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST", headers: headers(ts, "POST", path, body), body,
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`SL: ${data.msg}`);
}

// ─── Chandelier Exit ──────────────────────────────────────────────────────────
// Matches TradingView's "Chandelier Exit" indicator by everget.
// Runs the full sequential calculation over the candle history to get the
// current direction and stop levels. useClose=true matches the TV default.

function calcATR(candles, period) {
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

function calcCE(candles, period = 22, mult = 3.0) {
  if (candles.length < period * 2 + 1) return null;

  let dir = 1, longStop = 0, shortStop = 0;

  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i + 1);
    const atr   = calcATR(slice, period);
    if (!atr) continue;

    const highest = Math.max(...slice.map(c => c.close));
    const lowest  = Math.min(...slice.map(c => c.close));

    const prevClose = candles[i - 1].close;
    const currClose = candles[i].close;

    // Long stop ratchets upward only
    const lsNew = highest - mult * atr;
    const lsPrev = longStop;
    longStop = (i > period && prevClose > lsPrev) ? Math.max(lsNew, lsPrev) : lsNew;

    // Short stop ratchets downward only
    const ssNew  = lowest + mult * atr;
    const ssPrev = shortStop;
    shortStop = (i > period && prevClose < ssPrev) ? Math.min(ssNew, ssPrev) : ssNew;

    // Direction flips
    if      (dir === -1 && currClose > ssPrev) dir = 1;
    else if (dir ===  1 && currClose < lsPrev) dir = -1;
  }

  return { dir, longStop, shortStop };
}

// ─── Trade Execution ──────────────────────────────────────────────────────────

const HR = "═".repeat(56);

async function executeCESignal(action, symbol) {
  const direction = action === "buy" ? "long" : "short";
  const oppSide   = direction === "long" ? "short" : "long";

  console.log(`\n${HR}`);
  console.log(`  CE ${action.toUpperCase()} — ${symbol}   ${new Date().toISOString()}`);
  console.log(`${HR}\n`);

  // ── 1. Fetch candles and compute CE ────────────────────────────────────────
  const candles = await fetchCandles(symbol, CONFIG.timeframe);
  const price   = candles[candles.length - 1].close;
  const ce      = calcCE(candles, CONFIG.atrPeriod, CONFIG.atrMultiplier);

  if (!ce) {
    console.log("⚠️  CE calculation failed (not enough candles) — skipping");
    return;
  }

  const ceDir = ce.dir === 1 ? "Bullish ↑" : "Bearish ↓";
  console.log(`  Price        : $${price.toFixed(2)}`);
  console.log(`  CE direction : ${ceDir}`);
  console.log(`  Long stop    : $${ce.longStop.toFixed(2)}`);
  console.log(`  Short stop   : $${ce.shortStop.toFixed(2)}`);

  // ── 2. Sanity check — CE must agree with the incoming signal ──────────────
  // Guards against stale webhooks firing after CE has already flipped back.
  const ceAgrees = (direction === "long" && ce.dir === 1) || (direction === "short" && ce.dir === -1);
  if (!ceAgrees) {
    console.log(`\n⚠️  CE is ${ceDir} but signal is ${action.toUpperCase()} — stale webhook, skipping`);
    return;
  }

  // ── 3. Close any open opposite position ───────────────────────────────────
  const oppPos = await getOpenPosition(symbol, oppSide);
  if (oppPos) {
    console.log(`\n🔄 Closing ${oppSide} position (${oppPos.total} ${symbol})...`);
    if (!CONFIG.paperTrading) {
      await closeAllPositions(symbol);
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log("📋 PAPER: close skipped");
    }
  }

  // ── 4. Position sizing — 1% risk, capped at maxTradeSizeUSD ───────────────
  const slPrice   = direction === "long" ? ce.longStop : ce.shortStop;
  const slDistPct = Math.abs(slPrice - price) / price;

  if (slDistPct < 0.001) {
    console.log(`\n⚠️  SL distance only ${(slDistPct * 100).toFixed(3)}% — too tight, skipping`);
    return;
  }

  const riskUSD  = CONFIG.portfolioValue * 0.01;        // 1% of portfolio
  const notional = riskUSD / slDistPct;                 // position notional
  const margin   = Math.min(notional / CONFIG.leverage, CONFIG.maxTradeSizeUSD);
  const qty      = (margin * CONFIG.leverage) / price;

  console.log(`\n── Levels ───────────────────────────────────────────────`);
  console.log(`  Entry        : $${price.toFixed(2)}`);
  console.log(`  Stop Loss    : $${slPrice.toFixed(2)}  (${(slDistPct * 100).toFixed(2)}% away — CE stop)`);
  console.log(`  Exit signal  : next opposite CE flip from TradingView`);
  console.log(`  Margin       : $${margin.toFixed(2)} | ${CONFIG.leverage}x leverage`);
  console.log(`  Notional     : ~$${(margin * CONFIG.leverage).toFixed(2)}`);
  console.log(`  $ at risk    : $${(margin * CONFIG.leverage * slDistPct).toFixed(2)} (~1% portfolio)`);

  if (CONFIG.paperTrading) {
    console.log(`\n📋 PAPER TRADE — ${direction.toUpperCase()} ${symbol} @ $${price.toFixed(2)}`);
    console.log(`   SL $${slPrice.toFixed(2)}  |  exit on next CE flip\n`);
    return;
  }

  // ── 5. Live execution ──────────────────────────────────────────────────────
  console.log(`\n🔴 LIVE — ${direction.toUpperCase()} ${symbol} @ $${price.toFixed(2)} | ${CONFIG.leverage}x`);

  await setLeverage(symbol, CONFIG.leverage);

  const side  = direction === "long" ? "buy" : "sell";
  const order = await placeMarketOrder(symbol, side, qty);
  console.log(`✅ ENTRY: ${order?.orderId ?? "placed"}`);

  await new Promise(r => setTimeout(r, 3000));

  await placeSL(symbol, direction, slPrice);
  console.log(`✅ SL SET: $${slPrice.toFixed(2)}`);

  console.log(`\n  Exit: bot will close + reverse on next CE flip webhook.\n${HR}\n`);
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {

  // Health check — Railway uses this to confirm the service is running
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", bot: "ce-bot",
      mode:   CONFIG.paperTrading ? "paper" : "live",
      time:   new Date().toISOString(),
    }));
    return;
  }

  // TradingView webhook endpoint
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        // Optional shared-secret check
        if (CONFIG.webhookSecret) {
          const incoming = req.headers["x-webhook-secret"] || req.headers["x-tv-secret"];
          if (incoming !== CONFIG.webhookSecret) {
            console.log("⚠️  Rejected webhook — bad secret");
            res.writeHead(401); res.end("Unauthorized");
            return;
          }
        }

        const payload = JSON.parse(body);
        console.log("📨 Webhook received:", JSON.stringify(payload));

        const action = (payload.action || "").toLowerCase();
        const symbol = (payload.symbol || "BTCUSDT").toUpperCase().replace(/[^A-Z]/g, "");

        if (!["buy", "sell"].includes(action)) {
          res.writeHead(400); res.end("action must be buy or sell");
          return;
        }

        // Respond immediately — TradingView has a short timeout
        res.writeHead(200); res.end("OK");

        // Execute asynchronously so we don't block the HTTP response
        executeCESignal(action, symbol).catch(err =>
          console.error(`❌ Execution error: ${err.message}`)
        );

      } catch (err) {
        console.error("Webhook parse error:", err.message);
        res.writeHead(400); res.end("Bad JSON");
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const PORT = parseInt(process.env.PORT || "3000");
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n${HR}`);
  console.log("  Chandelier Exit Bot — BitGet USDT-M Futures");
  console.log(`  Mode      : ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log(`  Listening : http://0.0.0.0:${PORT}/webhook`);
  console.log(`  Timeframe : ${CONFIG.timeframe} | ATR(${CONFIG.atrPeriod}) × ${CONFIG.atrMultiplier}`);
  console.log(`  Leverage  : ${CONFIG.leverage}x | Max size $${CONFIG.maxTradeSizeUSD}`);
  console.log(`${HR}\n`);
});

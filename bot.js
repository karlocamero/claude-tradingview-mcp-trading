/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Strategy: EMA Pullback Strategy (4H)
 * EMAs 8/20/50/200 — trend filter, pullback detection, reversal trigger, volume confirmation.
 *
 * Local mode:  node bot.js
 * Cloud mode:  Railway cron — 0 *\/4 * * *
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { google } from "googleapis";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["KRAKEN_API_KEY", "KRAKEN_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length === 0) return;
  if (!existsSync(".env")) {
    writeFileSync(
      ".env",
      [
        "# Kraken credentials",
        "KRAKEN_API_KEY=",
        "KRAKEN_SECRET_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "TIMEFRAME=4H",
        "",
        "# Google Sheets (required for Railway — trades + position persistence)",
        "GOOGLE_SHEET_ID=",
        "GOOGLE_CLIENT_EMAIL=",
        "GOOGLE_PRIVATE_KEY=",
      ].join("\n") + "\n",
    );
    console.log("\n⚠️  No .env file found — created one for you to fill in.");
  } else {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
  }
  console.log("Add the missing values to .env then re-run: node bot.js\n");
  process.exit(0);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe:       process.env.TIMEFRAME || "4H",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY    || "3"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  kraken: {
    apiKey:    process.env.KRAKEN_API_KEY,
    secretKey: process.env.KRAKEN_SECRET_KEY,
    baseUrl:   "https://api.kraken.com",
  },
};

const LOG_FILE       = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE       = "trades.csv";
const CSV_HEADER_ROW = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side",
  "Quantity", "Price", "Total USD", "Fee (est. 0.4%)",
  "Net Amount", "Order ID", "Mode", "Notes",
];

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

let _sheetsClient = null;

async function getSheetClient() {
  if (_sheetsClient) return _sheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  _sheetsClient = google.sheets({ version: "v4", auth });
  return _sheetsClient;
}

async function ensureTradeSheetHeaders() {
  const sheets = await getSheetClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Trades!A1",
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Trades!A1",
      valueInputOption: "USER_ENTERED",
      resource: { values: [CSV_HEADER_ROW] },
    });
    console.log("Google Sheets: header row written to Trades tab");
  }
}

async function appendTradeToSheet(rowValues) {
  const sheets = await getSheetClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Trades!A:A",
    valueInputOption: "USER_ENTERED",
    resource: { values: [rowValues] },
  });
}

async function loadPositionsFromSheet() {
  const sheets = await getSheetClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Positions!A1",
  });
  const val = res.data.values?.[0]?.[0];
  return val ? JSON.parse(val) : {};
}

async function savePositionsToSheet(positions) {
  const sheets = await getSheetClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Positions!A1",
    valueInputOption: "RAW",
    resource: { values: [[JSON.stringify(positions)]] },
  });
}

// ─── Position Tracking ────────────────────────────────────────────────────────

async function loadPositions() {
  if (process.env.GOOGLE_SHEET_ID) return await loadPositionsFromSheet();
  if (!existsSync(POSITIONS_FILE)) return {};
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

async function savePositions(positions) {
  if (process.env.GOOGLE_SHEET_ID) { await savePositionsToSheet(positions); return; }
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// ─── Market Data (Kraken public API) ──────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 720) {
  const intervalMap = {
    "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
    "1H": 60, "4H": 240, "1D": 1440, "1W": 10080,
  };
  const krakenInterval = intervalMap[interval] || 1;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${symbol}&interval=${krakenInterval}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken API error: ${res.status}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken API error: ${data.error[0]}`);
  const pairData = Object.values(data.result).find((v) => Array.isArray(v));
  if (!pairData?.length) throw new Error(`No candle data returned for ${symbol}`);
  return pairData.slice(-limit).map((k) => ({
    time:   k[0] * 1000,
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[6]),
  }));
}

// ─── Indicator Calculations ───────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// Full EMA series aligned 1:1 with closes (null for warmup candles)
function calcEMASeriesFull(closes, period) {
  if (closes.length < period) return closes.map(() => null);
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// True if EMA value now is higher than it was slopeLookback candles ago
function isEMASloping(closes, period, slopeLookback = 5) {
  if (closes.length < period + slopeLookback) return false;
  const recent = calcEMA(closes, period);
  const prev   = calcEMA(closes.slice(0, -slopeLookback), period);
  return recent !== null && prev !== null && recent > prev;
}

// ─── Pullback Analysis ────────────────────────────────────────────────────────

// Returns all pullback measurements regardless of validity so each condition
// can be displayed and checked independently in the safety check.
function analyzePullback(candles, ema20Series) {
  const closes  = candles.map((c) => c.close);
  const n       = closes.length;
  const lastIdx = n - 1;

  // Most recent swing high — simple local max, exclude last 3 candles
  let swingHighIdx   = -1;
  let swingHighPrice = null;
  for (let i = lastIdx - 3; i >= Math.max(1, lastIdx - 25); i--) {
    if (closes[i] > closes[i - 1] && closes[i] > closes[i + 1]) {
      swingHighIdx   = i;
      swingHighPrice = closes[i];
      break;
    }
  }

  const currentPrice = closes[lastIdx];
  const duration     = swingHighIdx >= 0 ? lastIdx - swingHighIdx : null;
  const depth        = swingHighPrice ? ((swingHighPrice - currentPrice) / swingHighPrice) * 100 : null;

  let trendIntact  = true;
  let touchedEMA20 = false;
  let swingLow     = swingHighIdx >= 0 ? Infinity : null;

  if (swingHighIdx >= 0) {
    for (let i = swingHighIdx + 1; i <= lastIdx; i++) {
      if (candles[i].low < swingLow) swingLow = candles[i].low;
      const e20 = ema20Series[i];
      if (!e20) continue;
      // Check for breakdown (only on non-reversal pullback candles)
      if (i < lastIdx && closes[i] < e20 * 0.99) trendIntact = false;
      // Touch check: close within 1% OR wick touches EMA
      const distPct = Math.abs((candles[i].close - e20) / e20) * 100;
      if (distPct <= 1.0 || candles[i].low <= e20) touchedEMA20 = true;
    }
    if (swingLow === Infinity) swingLow = null;
  }

  return {
    swingHighIdx,
    swingHighPrice,
    swingLow,
    duration,
    depth,
    trendIntact,
    touchedEMA20,
    durationValid: duration !== null && duration >= 3 && duration <= 7,
    depthValid:    depth !== null && depth >= 5 && depth <= 15,
  };
}

// ─── Reversal Candle Detection ────────────────────────────────────────────────

function detectReversalCandle(candles, ema20Series) {
  const n    = candles.length;
  if (n < 2) return { detected: false };
  const curr = candles[n - 1];
  const prev = candles[n - 2];
  const e20  = ema20Series[n - 1];
  if (!e20) return { detected: false };

  const currGreen = curr.close > curr.open;
  const prevRed   = prev.close < prev.open;
  const body      = Math.abs(curr.close - curr.open);
  const range     = curr.high - curr.low;
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;
  const upperWick = curr.high - Math.max(curr.open, curr.close);

  // Bullish engulfing: green body fully covers prior red body
  if (currGreen && prevRed && curr.open < prev.close && curr.close > prev.open) {
    return { detected: true, type: "bullish engulfing" };
  }

  // Hammer: small body (≤35% of range), lower wick ≥2× body, tiny upper wick
  if (range > 0 && body > 0 && body / range <= 0.35 && lowerWick >= 2 * body && upperWick <= body) {
    return { detected: true, type: "hammer" };
  }

  // Shakeout: wick dipped below EMA 20 but candle closed back above it
  if (curr.low < e20 && curr.close > e20) {
    return { detected: true, type: "shakeout" };
  }

  return { detected: false };
}

// ─── Volume Confirmation ──────────────────────────────────────────────────────

function checkVolumeConfirmation(candles, pullbackDuration) {
  const n = candles.length;
  if (pullbackDuration < 1 || n < pullbackDuration + 1) {
    return { passes: false, reversalVol: 0, avgPullbackVol: 0 };
  }
  const pbCandles    = candles.slice(n - 1 - pullbackDuration, n - 1);
  const avgPullbackVol = pbCandles.reduce((s, c) => s + c.volume, 0) / pbCandles.length;
  const reversalVol  = candles[n - 1].volume;
  return { passes: reversalVol > avgPullbackVol, reversalVol, avgPullbackVol };
}

// ─── Safety Check — 9 explicit conditions covering all 11 strategy rules ──────

function runSafetyCheck(candles, price, ema8, ema20, ema50, ema200, ema20Series) {
  const results = [];
  const closes  = candles.map((c) => c.close);

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");
  console.log("  TREND FILTER\n");

  // Rule 1 — price above EMA 200
  check(
    "Price above EMA 200",
    `> ${ema200.toFixed(4)}`,
    price.toFixed(4),
    price > ema200,
  );

  // Rule 2 — EMA stack strictly ordered
  const stackOk = ema8 > ema20 && ema20 > ema50 && ema50 > ema200;
  check(
    "EMA stack: 8 > 20 > 50 > 200",
    "strictly ordered",
    `${ema8.toFixed(4)} / ${ema20.toFixed(4)} / ${ema50.toFixed(4)} / ${ema200.toFixed(4)}`,
    stackOk,
  );

  // Rule 3 — all EMAs sloping upward
  const s8   = isEMASloping(closes, 8);
  const s20  = isEMASloping(closes, 20);
  const s50  = isEMASloping(closes, 50);
  const s200 = isEMASloping(closes, 200);
  check(
    "All EMAs sloping upward",
    "all rising",
    `EMA8:${s8 ? "↑" : "↓"} EMA20:${s20 ? "↑" : "↓"} EMA50:${s50 ? "↑" : "↓"} EMA200:${s200 ? "↑" : "↓"}`,
    s8 && s20 && s50 && s200,
  );

  console.log("\n  PULLBACK CONDITIONS\n");

  const pb = analyzePullback(candles, ema20Series);

  // Rule 5 — price at or within 1% of EMA 20
  const distPct = Math.abs((price - ema20) / ema20) * 100;
  check(
    "Price at / within 1% of EMA 20",
    "≤ 1%",
    `${distPct.toFixed(2)}% from EMA 20 ($${ema20.toFixed(4)})`,
    distPct <= 1.0,
  );

  // Rule 6 — pullback depth 5–15% from swing high
  check(
    "Pullback depth 5–15% from swing high",
    "5% ≤ depth ≤ 15%",
    pb.depth !== null
      ? `${pb.depth.toFixed(1)}% from swing high $${pb.swingHighPrice?.toFixed(4)}`
      : "no swing high found in last 25 candles",
    pb.depthValid,
  );

  // Rule 7 — pullback duration 3–7 candles
  check(
    "Pullback duration 3–7 candles",
    "3 ≤ n ≤ 7",
    pb.duration !== null ? `${pb.duration} candle${pb.duration === 1 ? "" : "s"}` : "no swing high found",
    pb.durationValid,
  );

  // Rule 8 — price did not break through EMA 20 toward EMA 50
  check(
    "Trend intact — no close below EMA 20 during pullback",
    "no breakdown",
    pb.trendIntact ? "intact" : "⚠ price broke below EMA 20",
    pb.trendIntact,
  );

  console.log("\n  ENTRY TRIGGER\n");

  // Rule 9 — bullish reversal candle (rule 10: waiting for candle close is implicit)
  const reversal = detectReversalCandle(candles, ema20Series);
  check(
    "Bullish reversal candle at EMA 20",
    "engulfing / hammer / shakeout",
    reversal.detected ? reversal.type : "none detected",
    reversal.detected,
  );

  console.log("\n  VOLUME CONFIRMATION\n");

  // Rule 11 — reversal candle volume > avg pullback volume
  const vol = pb.durationValid
    ? checkVolumeConfirmation(candles, pb.duration)
    : { passes: false, reversalVol: candles.at(-1)?.volume ?? 0, avgPullbackVol: 0 };
  check(
    "Reversal volume > avg pullback volume",
    "reversal > pullback avg",
    vol.reversalVol
      ? `reversal: ${vol.reversalVol.toFixed(2)} | pullback avg: ${vol.avgPullbackVol.toFixed(2)}`
      : "N/A — pullback duration invalid",
    vol.passes,
  );

  // ── Position sizing ────────────────────────────────────────────────────────
  // Stop = just below swing low of the pullback (Rule 16)
  const stopLevel    = pb.swingLow ? pb.swingLow * 0.999 : price * 0.95;
  const stopDistPct  = (price - stopLevel) / price;
  const maxLoss      = CONFIG.portfolioValue * 0.01;           // Rule 13
  const positionSize = stopDistPct > 0 ? maxLoss / stopDistPct : 0; // Rule 15
  const tp1          = price + 2 * (price - stopLevel);        // Rule 17: 2× risk

  const allPass = results.every((r) => r.pass);

  if (allPass) {
    console.log("\n── Position Sizing ──────────────────────────────────────\n");
    console.log(`  Account balance : $${CONFIG.portfolioValue.toFixed(2)}`);
    console.log(`  Max loss (1%)   : $${maxLoss.toFixed(2)}`);
    console.log(`  Entry price     : $${price.toFixed(4)}`);
    console.log(`  Stop loss       : $${stopLevel.toFixed(4)} (swing low)`);
    console.log(`  Risk distance   : ${(stopDistPct * 100).toFixed(2)}%`);
    console.log(`  Position size   : $${positionSize.toFixed(2)} → capped at $${Math.min(positionSize, CONFIG.maxTradeSizeUSD).toFixed(2)}`);
    console.log(`  TP1             : $${tp1.toFixed(4)} (2× risk — close 50%)`);
    console.log(`  TP2             : Trail stop under EMA 8 on remaining 50%`);
  }

  return { results, allPass, stopLevel, stopDistPct, positionSize, tp1, pb, reversal };
}

// ─── Exit Check ───────────────────────────────────────────────────────────────

function checkExitConditions(position, candles, price, ema8, ema20) {
  const closes = candles.map((c) => c.close);

  // Rule 19 — 4H candle closes below EMA 20
  if (price < ema20) {
    return {
      action: "stop",
      reason: `Rule 19: closed below EMA 20 ($${price.toFixed(4)} < $${ema20.toFixed(4)})`,
      closePercent: 1.0,
    };
  }

  // Rule 20 — EMA 8 crosses below EMA 20
  const ema8Prev  = calcEMA(closes.slice(0, -1), 8);
  const ema20Prev = calcEMA(closes.slice(0, -1), 20);
  if (ema8Prev && ema20Prev && ema8Prev > ema20Prev && ema8 <= ema20) {
    return {
      action: "stop",
      reason: `Rule 20: EMA 8 crossed below EMA 20 (bearish crossover)`,
      closePercent: 1.0,
    };
  }

  // Rule 21 — close below original stop loss
  if (price <= position.stopLevel) {
    return {
      action: "stop",
      reason: `Rule 21: price $${price.toFixed(4)} ≤ stop $${position.stopLevel.toFixed(4)}`,
      closePercent: 1.0,
    };
  }

  // TP1 — entry + 2× risk, close 50% (Rule 17)
  if (!position.tp1Hit && position.tp1Level && price >= position.tp1Level) {
    return {
      action: "tp1",
      reason: `TP1: $${price.toFixed(4)} reached 2× risk target $${position.tp1Level.toFixed(4)}`,
      closePercent: 0.50,
    };
  }

  // TP2 — after TP1, trail remaining 50% under EMA 8 (Rule 18)
  if (position.tp1Hit) {
    const trailStop = ema8 * 0.999;
    if (price <= trailStop) {
      return {
        action: "tp2",
        reason: `TP2 trail: $${price.toFixed(4)} fell below EMA 8 trail stop $${trailStop.toFixed(4)}`,
        closePercent: 1.0,
      };
    }
  }

  return { action: null, reason: null, closePercent: 0 };
}

// ─── Trade Limits ─────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);
  console.log(`✅ Max risk per trade: 1% of $${CONFIG.portfolioValue} = $${(CONFIG.portfolioValue * 0.01).toFixed(2)}`);
  return true;
}

// ─── Kraken Execution ─────────────────────────────────────────────────────────

function signKraken(path, nonce, encodedBody) {
  const sha256Hash = crypto.createHash("sha256").update(nonce.toString() + encodedBody).digest();
  const secretDecoded = Buffer.from(CONFIG.kraken.secretKey, "base64");
  return crypto.createHmac("sha512", secretDecoded)
    .update(Buffer.concat([Buffer.from(path), sha256Hash]))
    .digest("base64");
}

async function placeKrakenOrder(symbol, side, sizeUSD, price) {
  const quantity    = (sizeUSD / price).toFixed(8);
  const nonce       = Date.now() * 1000;
  const path        = "/0/private/AddOrder";
  const params      = new URLSearchParams({ nonce: nonce.toString(), ordertype: "market", type: side, volume: quantity, pair: symbol });
  const encodedBody = params.toString();
  const signature   = signKraken(path, nonce, encodedBody);
  const res = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "API-Key": CONFIG.kraken.apiKey, "API-Sign": signature },
    body: encodedBody,
  });
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken order failed: ${data.error[0]}`);
  return { orderId: data.result.txid[0] };
}

// ─── Trade Logging (Google Sheets + local CSV) ────────────────────────────────

const CSV_HEADERS = CSV_HEADER_ROW.join(",");

async function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
    console.log(`📄 Created ${CSV_FILE} — local backup of all trades`);
  }
  if (process.env.GOOGLE_SHEET_ID) {
    try { await ensureTradeSheetHeaders(); console.log(`📊 Google Sheets connected`); }
    catch (err) { console.log(`⚠️  Google Sheets init failed: ${err.message}`); }
  }
}

async function writeTrade(logEntry) {
  const now  = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED"; notes = `Failed: ${failed}`;
  } else {
    quantity  = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD  = logEntry.tradeSize.toFixed(2);
    fee       = (logEntry.tradeSize * 0.004).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId   = logEntry.orderId || "";
    mode      = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes     = logEntry.error ? `Error: ${logEntry.error}` : logEntry.exitReason || "All conditions met";
  }

  const rowValues = [
    date, time, "Kraken", logEntry.symbol, logEntry.side || "",
    quantity, logEntry.price.toFixed(4), totalUSD, fee, netAmount, orderId, mode, notes,
  ];

  if (process.env.GOOGLE_SHEET_ID) {
    try { await appendTradeToSheet(rowValues); console.log(`Trade logged → Google Sheets`); }
    catch (err) { console.log(`⚠️  Google Sheets write failed: ${err.message}`); }
  }

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  const csvRow = [...rowValues.slice(0, -1), `"${notes}"`].join(",");
  appendFileSync(CSV_FILE, csvRow + "\n");
  if (!process.env.GOOGLE_SHEET_ID) console.log(`Trade logged → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const lines   = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows    = lines.slice(1).map((l) => l.split(","));
  const live    = rows.filter((r) => r[11] === "LIVE");
  const paper   = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees   = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions : ${rows.length}`);
  console.log(`  Live trades     : ${live.length}`);
  console.log(`  Paper trades    : ${paper.length}`);
  console.log(`  Blocked         : ${blocked.length}`);
  console.log(`  Total volume    : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees est. : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  await initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — EMA Pullback Strategy");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy : ${rules.strategy.name}`);
  console.log(`Watchlist: ${rules.watchlist.join(", ")} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();
  if (!checkTradeLimits(log)) { console.log("\nBot stopping — trade limits reached."); return; }

  for (const symbol of rules.watchlist) {
    if (countTodaysTrades(loadLog()) >= CONFIG.maxTradesPerDay) {
      console.log("\nDaily trade limit reached. Stopping."); break;
    }
    await processSymbol(symbol);
  }

  console.log("═══════════════════════════════════════════════════════════\n");
}

async function processSymbol(symbol) {
  console.log(`\n── ${symbol} ${"─".repeat(Math.max(0, 53 - symbol.length))}\n`);

  let candles;
  try { candles = await fetchCandles(symbol, CONFIG.timeframe); }
  catch (err) { console.log(`⚠️  Skipping ${symbol} — ${err.message}`); return; }

  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];

  const ema8   = calcEMA(closes, 8);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const ema20Series = calcEMASeriesFull(closes, 20);

  console.log(`  Price  : $${price.toFixed(4)}`);
  console.log(`  EMA 8  : $${ema8   ? ema8.toFixed(4)   : "N/A"}`);
  console.log(`  EMA 20 : $${ema20  ? ema20.toFixed(4)  : "N/A"}`);
  console.log(`  EMA 50 : $${ema50  ? ema50.toFixed(4)  : "N/A"}`);
  console.log(`  EMA 200: $${ema200 ? ema200.toFixed(4) : "N/A"}`);

  if (!ema8 || !ema20 || !ema50 || !ema200) {
    console.log(`\n⚠️  Not enough candle data for ${symbol}. Skipping.`); return;
  }

  // ── Check open position first ──────────────────────────────────────────────
  const positions    = await loadPositions();
  const openPosition = positions[symbol];

  if (openPosition) {
    console.log(`\n── Open Position ─────────────────────────────────────────\n`);
    console.log(`  Entry     : $${openPosition.entryPrice.toFixed(4)}`);
    console.log(`  Remaining : $${openPosition.remainingSize.toFixed(2)} of $${openPosition.initialSize.toFixed(2)}`);
    console.log(`  Stop      : $${openPosition.stopLevel.toFixed(4)}`);
    if (openPosition.tp1Level) console.log(`  TP1       : $${openPosition.tp1Level.toFixed(4)}${openPosition.tp1Hit ? " ✅ hit" : ""}`);
    if (openPosition.tp1Hit)   console.log(`  TP2       : Trailing EMA 8 (current stop $${(ema8 * 0.999).toFixed(4)})`);

    const exitResult = checkExitConditions(openPosition, candles, price, ema8, ema20);

    if (exitResult.action) {
      const closeSize = openPosition.remainingSize * exitResult.closePercent;
      const pnl = (((price - openPosition.entryPrice) / openPosition.entryPrice) * 100).toFixed(3);
      console.log(`\n🔔 ${exitResult.action.toUpperCase()}: ${exitResult.reason}`);
      console.log(`   Closing $${closeSize.toFixed(2)} | P&L: ${pnl}%`);

      let orderId = null, orderPlaced = false;
      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER SELL — $${closeSize.toFixed(2)} of ${symbol} at $${price.toFixed(4)}`);
        orderId = `PAPER-${exitResult.action.toUpperCase()}-${Date.now()}`;
        orderPlaced = true;
      } else {
        try {
          const order = await placeKrakenOrder(symbol, "sell", closeSize, price);
          orderId = order.orderId; orderPlaced = true;
          console.log(`✅ SELL ORDER PLACED — ${orderId}`);
        } catch (err) { console.log(`❌ SELL ORDER FAILED — ${err.message}`); }
      }

      const log = loadLog();
      const closeEntry = {
        timestamp: new Date().toISOString(), symbol, side: "sell",
        timeframe: CONFIG.timeframe, price,
        indicators: { ema8, ema20, ema50, ema200 },
        conditions: [], allPass: true, tradeSize: closeSize, orderPlaced,
        orderId: orderId || `FAILED-${Date.now()}`,
        paperTrading: CONFIG.paperTrading, exitReason: exitResult.reason,
        exitAction: exitResult.action, limits: {},
      };
      log.trades.push(closeEntry);
      saveLog(log);
      await writeTrade(closeEntry);

      if (exitResult.action === "tp1") {
        positions[symbol] = {
          ...openPosition,
          tp1Hit: true,
          remainingSize: openPosition.remainingSize - closeSize,
          stopMode: "trailing_ema8",
        };
        console.log(`   Remaining $${positions[symbol].remainingSize.toFixed(2)} — now trailing EMA 8`);
        await savePositions(positions);
      } else {
        delete positions[symbol];
        await savePositions(positions);
        console.log(`   Position fully closed.`);
      }
    } else {
      console.log(`\n  Holding — no exit condition met.`);
      if (openPosition.tp1Hit) console.log(`  EMA 8 trail stop: $${(ema8 * 0.999).toFixed(4)}`);
    }
    return;
  }

  // ── No open position — evaluate entry ─────────────────────────────────────
  const { results, allPass, stopLevel, stopDistPct, positionSize, tp1 } =
    runSafetyCheck(candles, price, ema8, ema20, ema50, ema200, ema20Series);

  const tradeSize = Math.min(positionSize, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const log = loadLog();
  const logEntry = {
    timestamp: new Date().toISOString(), symbol, side: "buy",
    timeframe: CONFIG.timeframe, price,
    indicators: { ema8, ema20, ema50, ema200 },
    conditions: results, allPass, tradeSize,
    orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);
    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — buy ${symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${symbol}`);
      try {
        const order = await placeKrakenOrder(symbol, "buy", tradeSize, price);
        logEntry.orderPlaced = true; logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      positions[symbol] = {
        symbol, side: "buy", entryPrice: price,
        stopLevel, stopMode: "initial",
        tp1Level: tp1, tp1Hit: false,
        initialSize: tradeSize, remainingSize: tradeSize,
        entryTime: logEntry.timestamp, orderId: logEntry.orderId,
        paperTrading: CONFIG.paperTrading,
      };
      await savePositions(positions);
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  await writeTrade(logEntry);
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => { console.error("Bot error:", err); process.exit(1); });
}

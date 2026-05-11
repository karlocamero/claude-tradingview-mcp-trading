/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Strategy: EMA Pullback Speed Strategy (PakunFX) — 4H
 * Dynamic adaptive EMA + EMA 21/50 trend filter, candle pattern + speed entry,
 * ATR-based stop loss, fixed-% take profit.
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
        "ALLOW_SHORTS=false",
        "",
        "# PakunFX Strategy params (defaults match Pine Script)",
        "DYN_EMA_MAX_LENGTH=50",
        "ACCEL_MULTIPLIER=3.0",
        "RETURN_THRESHOLD=5.0",
        "ATR_LENGTH=14",
        "ATR_MULT=4.0",
        "FIXED_TP_PCT=3.0",
        "SHORT_EMA_LEN=21",
        "LONG_EMA_LEN=50",
        "LONG_SPEED_MIN=800",
        "SHORT_SPEED_MAX=-1000",
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
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  allowShorts: process.env.ALLOW_SHORTS === "true",
  strategy: {
    maxLength: parseInt(process.env.DYN_EMA_MAX_LENGTH || "50"),
    accelMultiplier: parseFloat(process.env.ACCEL_MULTIPLIER || "3.0"),
    returnThreshold: parseFloat(process.env.RETURN_THRESHOLD || "5.0"),
    atrLength: parseInt(process.env.ATR_LENGTH || "14"),
    atrMult: parseFloat(process.env.ATR_MULT || "4.0"),
    fixedTpPct: parseFloat(process.env.FIXED_TP_PCT || "3.0"),
    shortEmaLen: parseInt(process.env.SHORT_EMA_LEN || "21"),
    longEmaLen: parseInt(process.env.LONG_EMA_LEN || "50"),
    longSpeedMin: parseFloat(process.env.LONG_SPEED_MIN || "800"),
    shortSpeedMax: parseFloat(process.env.SHORT_SPEED_MAX || "-1000"),
  },
  kraken: {
    apiKey: process.env.KRAKEN_API_KEY,
    secretKey: process.env.KRAKEN_SECRET_KEY,
    baseUrl: "https://api.kraken.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE = "trades.csv";
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
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
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
    time: k[0] * 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
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

// Dynamic adaptive EMA — matches PakunFX Pine Script logic exactly.
// Length shortens when price accelerates; lengthens when price is near recent highs.
function calcDynamicEMAFull(candles, maxLength = 50, accelMultiplier = 3.0) {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const result = [];
  let dynEma = null;

  for (let i = 0; i < n; i++) {
    const wStart = Math.max(0, i - 199);
    const window = closes.slice(wStart, i + 1);

    // Normalise current close within its 200-bar range (0.5 – 1.0)
    const maxClose = Math.max(...window);
    const countsDiffNorm = maxClose === 0 ? 0.5 : (closes[i] + maxClose) / (2 * maxClose);
    const dynLength = 5 + countsDiffNorm * (maxLength - 5);

    // Acceleration factor: how fast price is changing vs its own recent history
    const deltas = [];
    for (let j = Math.max(1, wStart); j <= i; j++) {
      deltas.push(Math.abs(closes[j] - closes[j - 1]));
    }
    const delta = i > 0 ? Math.abs(closes[i] - closes[i - 1]) : 0;
    const maxDelta = deltas.length > 0 ? Math.max(...deltas) : 1;
    const accelFactor = maxDelta === 0 ? 0 : delta / maxDelta;

    const alphaBase = 2 / (dynLength + 1);
    const alpha = Math.min(1, alphaBase * (1 + accelFactor * accelMultiplier));

    dynEma = dynEma === null ? closes[i] : alpha * closes[i] + (1 - alpha) * dynEma;
    result.push(dynEma);
  }

  return result;
}

// ATR using Wilder's RMA (matches ta.atr in Pine Script)
function calcATRFull(candles, period = 14) {
  const n = candles.length;
  const result = new Array(n).fill(null);
  const k = 1 / period;
  let rma = null;

  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    rma = rma === null ? tr : tr * k + rma * (1 - k);
    result[i] = rma;
  }

  return result;
}

// ─── Safety Check — PakunFX strategy conditions ───────────────────────────────

function runSafetyCheck(candles, price, emaShort, emaLong, dynEmaFull, atrFull) {
  const results = [];
  const n = candles.length;
  const dynEma = dynEmaFull[n - 1];
  const atr = atrFull[n - 1];
  const s = CONFIG.strategy;

  if (!dynEma || !atr) return { results, allPass: false, direction: null };

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  // Speed = candle body in USD (close − open)
  const curr = candles[n - 1];
  const prev1 = candles[n - 2];
  const prev2 = candles[n - 3];
  const speed = curr.close - curr.open;
  const distance = Math.abs(price - dynEma) / dynEma * 100;

  // Candle pattern: two consecutive green candles then current breaks above prior high
  const bullishReversal = (
    prev2.close > prev2.open &&
    prev1.close > prev1.open &&
    price > prev1.high
  );

  // Candle pattern: two consecutive red candles then current breaks below prior low
  const bearishReversal = (
    prev2.close < prev2.open &&
    prev1.close < prev1.open &&
    price < prev1.low
  );

  const isUptrend = price > dynEma;
  const isDowntrend = price < dynEma;
  const emaUptrend = emaShort > emaLong;
  const emaDowntrend = emaShort < emaLong;
  const returnedToTrend = distance < s.returnThreshold;

  const longOk = isUptrend && bullishReversal && returnedToTrend && emaUptrend && speed >= s.longSpeedMin;
  const shortOk = isDowntrend && bearishReversal && returnedToTrend && speed < 0 && emaDowntrend && speed <= s.shortSpeedMax;

  const direction = longOk ? "long" : (shortOk && CONFIG.allowShorts ? "short" : null);

  console.log("\n── Safety Check ─────────────────────────────────────────\n");
  console.log("  TREND FILTER\n");

  check(
    "EMA filter (EMA21 vs EMA50)",
    longOk || !shortOk ? "EMA21 > EMA50 (uptrend)" : "EMA21 < EMA50 (downtrend)",
    `EMA21: ${emaShort.toFixed(2)} / EMA50: ${emaLong.toFixed(2)}`,
    longOk ? emaUptrend : emaDowntrend,
  );

  check(
    "Price vs Dynamic EMA",
    longOk || !shortOk ? "price > dynEMA" : "price < dynEMA",
    `price: ${price.toFixed(2)} | dynEMA: ${dynEma.toFixed(2)}`,
    longOk ? isUptrend : isDowntrend,
  );

  console.log("\n  ENTRY CONDITIONS\n");

  check(
    "Returned to Dynamic EMA",
    `distance < ${s.returnThreshold}%`,
    `${distance.toFixed(2)}%`,
    returnedToTrend,
  );

  check(
    "Candle reversal pattern",
    longOk || !shortOk
      ? "2 consecutive green candles + close > prior high"
      : "2 consecutive red candles + close < prior low",
    longOk || !shortOk
      ? `prev2Green:${prev2.close > prev2.open} prev1Green:${prev1.close > prev1.open} breakHigh:${price > prev1.high}`
      : `prev2Red:${prev2.close < prev2.open} prev1Red:${prev1.close < prev1.open} breakLow:${price < prev1.low}`,
    longOk ? bullishReversal : bearishReversal,
  );

  check(
    "Speed filter (candle body in USD)",
    longOk || !shortOk ? `>= $${s.longSpeedMin}` : `<= $${s.shortSpeedMax}`,
    `$${speed.toFixed(2)}`,
    longOk ? speed >= s.longSpeedMin : speed <= s.shortSpeedMax,
  );

  const allPass = longOk || (shortOk && CONFIG.allowShorts);

  // Position sizing — risk 1% of portfolio, cap at maxTradeSizeUSD
  const stopDist = atr * s.atrMult;
  const stopLevel = direction === "long" ? price - stopDist : price + stopDist;
  const tpLevel = direction === "long"
    ? price + price * s.fixedTpPct / 100
    : price - price * s.fixedTpPct / 100;

  const stopDistPct = stopDist / price;
  const maxLoss = CONFIG.portfolioValue * 0.01;
  const positionSize = stopDistPct > 0 ? maxLoss / stopDistPct : 0;

  if (allPass) {
    console.log("\n── Position Sizing ──────────────────────────────────────\n");
    console.log(`  Direction    : ${direction?.toUpperCase()}`);
    console.log(`  Account      : $${CONFIG.portfolioValue.toFixed(2)}`);
    console.log(`  Max loss (1%): $${maxLoss.toFixed(2)}`);
    console.log(`  ATR          : $${atr.toFixed(2)}`);
    console.log(`  Entry price  : $${price.toFixed(4)}`);
    console.log(`  Stop loss    : $${stopLevel.toFixed(4)} (ATR × ${s.atrMult})`);
    console.log(`  Take profit  : $${tpLevel.toFixed(4)} (${s.fixedTpPct}% fixed)`);
    console.log(`  Risk distance: ${(stopDistPct * 100).toFixed(2)}%`);
    console.log(`  Position size: $${positionSize.toFixed(2)} → capped at $${Math.min(positionSize, CONFIG.maxTradeSizeUSD).toFixed(2)}`);
  }

  return { results, allPass, direction, stopLevel, tpLevel, stopDistPct, positionSize };
}

// ─── Exit Check ───────────────────────────────────────────────────────────────

function checkExitConditions(position, price) {
  if (position.side === "buy") {
    if (price >= position.tpLevel) {
      return {
        action: "tp",
        reason: `TP hit: $${price.toFixed(4)} ≥ $${position.tpLevel.toFixed(4)} (${CONFIG.strategy.fixedTpPct}%)`,
        closePercent: 1.0,
      };
    }
    if (price <= position.stopLevel) {
      return {
        action: "stop",
        reason: `Stop hit: $${price.toFixed(4)} ≤ $${position.stopLevel.toFixed(4)} (ATR × ${CONFIG.strategy.atrMult})`,
        closePercent: 1.0,
      };
    }
  } else {
    if (price <= position.tpLevel) {
      return {
        action: "tp",
        reason: `TP hit: $${price.toFixed(4)} ≤ $${position.tpLevel.toFixed(4)} (${CONFIG.strategy.fixedTpPct}%)`,
        closePercent: 1.0,
      };
    }
    if (price >= position.stopLevel) {
      return {
        action: "stop",
        reason: `Stop hit: $${price.toFixed(4)} ≥ $${position.stopLevel.toFixed(4)} (ATR × ${CONFIG.strategy.atrMult})`,
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
  const quantity = (sizeUSD / price).toFixed(8);
  if (parseFloat(quantity) < 0.0001) throw new Error(`Order too small: ${quantity} BTC (Kraken minimum is 0.0001)`);
  const nonce = Date.now() * 1000;
  const path = "/0/private/AddOrder";
  const params = new URLSearchParams({ nonce: nonce.toString(), ordertype: "market", type: side, volume: quantity, pair: symbol });
  const encodedBody = params.toString();
  const signature = signKraken(path, nonce, encodedBody);
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
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED"; notes = `Failed: ${failed}`;
  } else {
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.004).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : logEntry.exitReason || "All conditions met";
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
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
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
  console.log("  Claude Trading Bot — EMA Pullback Speed Strategy (PakunFX)");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Shorts: ${CONFIG.allowShorts ? "enabled (⚠️  requires Kraken margin)" : "disabled"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy : EMA Pullback Speed (PakunFX) — 4H`);
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
  const price = closes[closes.length - 1];
  const s = CONFIG.strategy;

  const emaShort = calcEMA(closes, s.shortEmaLen);
  const emaLong = calcEMA(closes, s.longEmaLen);
  const dynEmaFull = calcDynamicEMAFull(candles, s.maxLength, s.accelMultiplier);
  const atrFull = calcATRFull(candles, s.atrLength);

  const dynEma = dynEmaFull[dynEmaFull.length - 1];
  const atr = atrFull[atrFull.length - 1];

  console.log(`  Price    : $${price.toFixed(4)}`);
  console.log(`  EMA ${s.shortEmaLen}   : $${emaShort ? emaShort.toFixed(4) : "N/A"}`);
  console.log(`  EMA ${s.longEmaLen}   : $${emaLong ? emaLong.toFixed(4) : "N/A"}`);
  console.log(`  Dyn EMA  : $${dynEma ? dynEma.toFixed(4) : "N/A"}`);
  console.log(`  ATR(${s.atrLength})  : $${atr ? atr.toFixed(4) : "N/A"}`);

  if (!emaShort || !emaLong || !dynEma || !atr) {
    console.log(`\n⚠️  Not enough candle data for ${symbol}. Skipping.`); return;
  }

  // ── Check open position first ──────────────────────────────────────────────
  const positions = await loadPositions();
  const openPosition = positions[symbol];

  if (openPosition) {
    console.log(`\n── Open Position ─────────────────────────────────────────\n`);
    console.log(`  Side      : ${openPosition.side === "buy" ? "LONG" : "SHORT"}`);
    console.log(`  Entry     : $${openPosition.entryPrice.toFixed(4)}`);
    console.log(`  Size      : $${openPosition.remainingSize.toFixed(2)}`);
    console.log(`  Stop      : $${openPosition.stopLevel.toFixed(4)}`);
    console.log(`  TP        : $${openPosition.tpLevel.toFixed(4)}`);

    const exitResult = checkExitConditions(openPosition, price);

    if (exitResult.action) {
      const closeSize = openPosition.remainingSize * exitResult.closePercent;
      const pnlPct = (((price - openPosition.entryPrice) / openPosition.entryPrice) * 100).toFixed(3);
      const exitSide = openPosition.side === "buy" ? "sell" : "buy";

      console.log(`\n🔔 ${exitResult.action.toUpperCase()}: ${exitResult.reason}`);
      console.log(`   Closing $${closeSize.toFixed(2)} | P&L: ${pnlPct}%`);

      let orderId = null, orderPlaced = false;
      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER ${exitSide.toUpperCase()} — $${closeSize.toFixed(2)} of ${symbol} at $${price.toFixed(4)}`);
        orderId = `PAPER-${exitResult.action.toUpperCase()}-${Date.now()}`;
        orderPlaced = true;
      } else {
        try {
          const order = await placeKrakenOrder(symbol, exitSide, closeSize, price);
          orderId = order.orderId; orderPlaced = true;
          console.log(`✅ ${exitSide.toUpperCase()} ORDER PLACED — ${orderId}`);
        } catch (err) { console.log(`❌ ${exitSide.toUpperCase()} ORDER FAILED — ${err.message}`); }
      }

      const log = loadLog();
      const closeEntry = {
        timestamp: new Date().toISOString(), symbol, side: exitSide,
        timeframe: CONFIG.timeframe, price,
        indicators: { emaShort, emaLong, dynEma, atr },
        conditions: [], allPass: true, tradeSize: closeSize, orderPlaced,
        orderId: orderId || `FAILED-${Date.now()}`,
        paperTrading: CONFIG.paperTrading, exitReason: exitResult.reason,
        exitAction: exitResult.action, limits: {},
      };
      log.trades.push(closeEntry);
      saveLog(log);
      await writeTrade(closeEntry);

      delete positions[symbol];
      await savePositions(positions);
      console.log(`   Position closed.`);
    } else {
      const pnlPct = (((price - openPosition.entryPrice) / openPosition.entryPrice) * 100).toFixed(3);
      console.log(`\n  Holding — no exit condition met. Current P&L: ${pnlPct}%`);
    }
    return;
  }

  // ── No open position — evaluate entry ─────────────────────────────────────
  const { results, allPass, direction, stopLevel, tpLevel, stopDistPct, positionSize } =
    runSafetyCheck(candles, price, emaShort, emaLong, dynEmaFull, atrFull);

  const tradeSize = Math.min(positionSize, CONFIG.maxTradeSizeUSD);
  const entrySide = direction === "short" ? "sell" : "buy";

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const log = loadLog();
  const logEntry = {
    timestamp: new Date().toISOString(), symbol, side: entrySide,
    timeframe: CONFIG.timeframe, price,
    indicators: { emaShort, emaLong, dynEma, atr },
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
    console.log(`✅ ALL CONDITIONS MET — ${direction?.toUpperCase()}`);
    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — ${entrySide} ${symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${entrySide.toUpperCase()} ${symbol}`);
      try {
        const order = await placeKrakenOrder(symbol, entrySide, tradeSize, price);
        logEntry.orderPlaced = true; logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      positions[symbol] = {
        symbol,
        side: entrySide,
        entryPrice: price,
        stopLevel,
        tpLevel,
        initialSize: tradeSize,
        remainingSize: tradeSize,
        entryTime: logEntry.timestamp,
        orderId: logEntry.orderId,
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

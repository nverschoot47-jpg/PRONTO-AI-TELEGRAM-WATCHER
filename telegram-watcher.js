"use strict";
// ================================================================
// PRONTO-AI — Telegram Alert Watcher  (4th, standalone Railway service)
//
// Polls the existing /api/open-positions endpoint of each of your
// broker services (FTMO / Vantage / Maven / future accounts) every
// few seconds. Whenever a NEW positionId shows up that wasn't seen
// before, it sends a Telegram alert.
//
// ZERO changes needed to any of your existing 3 repos — this is a
// completely separate Railway service that just reads their public
// API, the same way your dashboard already does.
//
// ── Required env vars (set in THIS Railway service only) ───────────
//   TELEGRAM_BOT_TOKEN   = 8769112532:AAG31SZrYQfGOUCH2pTwtXsgSA6V8L9mp1c
//   TELEGRAM_CHAT_ID     = 7667906358
//   ACCOUNTS             = JSON array, see below
//   POLL_INTERVAL_MS     = optional, default 10000 (10s)
//
// Example ACCOUNTS value (set as ONE single-line env var in Railway):
//   [{"label":"FTMO","url":"https://your-ftmo-service.up.railway.app"},
//    {"label":"VANTAGE","url":"https://your-vantage-service.up.railway.app"},
//    {"label":"MAVEN","url":"https://your-maven-service.up.railway.app"}]
//
// To add a future account later: just add one more object to the
// ACCOUNTS env var, no redeploy of other services needed.
// ================================================================

const https = require("https");
const http  = require("http");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || "";
const POLL_INTERVAL_MS   = parseInt(process.env.POLL_INTERVAL_MS) || 10000;

let ACCOUNTS = [];
try {
  ACCOUNTS = JSON.parse(process.env.ACCOUNTS || "[]");
} catch (e) {
  console.error(`[Watcher] Failed to parse ACCOUNTS env var as JSON: ${e.message}`);
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("[Watcher] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — alerts cannot be sent.");
}
if (!ACCOUNTS.length) {
  console.error("[Watcher] ACCOUNTS env var is empty or invalid — nothing to watch. See file header for format.");
}

// Tracks positionIds we've already alerted on, per account label
// (in-memory only — resets on redeploy, which just means you might
//  get re-alerted once for positions that were already open. Fine.)
const seenPositions = new Map(); // label -> Set of positionIds

// ── Generic JSON GET over https or http ─────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

// ── Send Telegram message (no dependency, raw https) ────────────────
function telegramSendMessage(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
          else reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Format alert for a newly detected open position ─────────────────
function formatAlert(label, pos) {
  const fmt = (n, d = 2) => (n == null ? "--" : Number(n).toFixed(d));
  const isIndex = pos.assetType === "index";
  const priceDp = isIndex ? 2 : 4;
  const dirIcon = pos.direction === "buy" ? "🟢 BUY" : "🔴 SELL";

  return [
    `<b>[${label}] ${pos.symbol} ${dirIcon}</b>`,
    ``,
    `Entry: <b>${fmt(pos.entry, priceDp)}</b>`,
    `SL: ${fmt(pos.sl, priceDp)}  |  TP: ${fmt(pos.tp, priceDp)}`,
    ``,
    `Lots: <b>${fmt(pos.lots, 2)}</b>`,
    `Risk: <b>€${fmt(pos.riskEur)}</b>`,
    ``,
    `Session: ${pos.session || "--"}  |  ${pos.dailyLabel || ""}`,
    `ID: ${pos.positionId}`,
  ].join("\n");
}

// ── Poll one account, detect + alert on new positions ────────────────
async function pollAccount(account) {
  const { label, url } = account;
  if (!seenPositions.has(label)) seenPositions.set(label, new Set());
  const seen = seenPositions.get(label);

  let positions;
  try {
    positions = await fetchJson(`${url.replace(/\/$/, "")}/api/open-positions`);
  } catch (e) {
    console.error(`[Watcher] ${label}: failed to fetch open-positions — ${e.message}`);
    return;
  }

  if (!Array.isArray(positions)) {
    console.error(`[Watcher] ${label}: unexpected response shape (not an array)`);
    return;
  }

  // First poll for this account: just record what's already open,
  // don't spam alerts for trades that existed before the watcher started.
  const isFirstPoll = seen.size === 0 && !account._initialized;
  if (isFirstPoll) {
    positions.forEach((p) => seen.add(String(p.positionId)));
    account._initialized = true;
    console.log(`[Watcher] ${label}: initialized with ${positions.length} existing open position(s)`);
    return;
  }

  for (const pos of positions) {
    const id = String(pos.positionId);
    if (!seen.has(id)) {
      seen.add(id);
      try {
        await telegramSendMessage(formatAlert(label, pos));
        console.log(`[Watcher] ${label}: alert sent for new position ${id}`);
      } catch (e) {
        console.error(`[Watcher] ${label}: failed to send Telegram alert — ${e.message}`);
      }
    }
  }
}

// ── Main poll loop ───────────────────────────────────────────────────
async function pollAll() {
  for (const account of ACCOUNTS) {
    await pollAccount(account);
  }
}

console.log(`[Watcher] Starting — watching ${ACCOUNTS.length} account(s), poll every ${POLL_INTERVAL_MS}ms`);
ACCOUNTS.forEach((a) => console.log(`[Watcher]   - ${a.label} → ${a.url}`));

pollAll();
setInterval(pollAll, POLL_INTERVAL_MS);

// ── Minimal HTTP server so Railway healthcheck has something to hit ──
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        watching: ACCOUNTS.map((a) => a.label),
        pollIntervalMs: POLL_INTERVAL_MS,
      })
    );
  })
  .listen(PORT, () => console.log(`[Watcher] Healthcheck server listening on :${PORT}`));

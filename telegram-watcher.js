"use strict";
// ================================================================
// PRONTO-AI — Telegram Alert Watcher (standalone Railway service)
//
// Polls /api/open-positions of each account every few seconds and
// sends a Telegram alert when a NEW positionId shows up, when a
// position disappears (closed), and when an account goes down / recovers.
//
// Env vars (set in Railway, NEVER in this file):
//   TELEGRAM_BOT_TOKEN   bot token from @BotFather
//   TELEGRAM_CHAT_ID     chat or group id (groups are negative)
//   ACCOUNTS             JSON array: [{"label":"FTMO","url":"https://..."}]
//   POLL_INTERVAL_MS     optional, default 10000
//   REQUEST_TIMEOUT_MS   optional, default 8000
//   NOTIFY_CLOSED        optional, "false" to disable closed-trade alerts
//   DOWN_AFTER_FAILS     optional, default 3 consecutive failures before alert
// ================================================================

const https = require("https");
const http  = require("http");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || "";
const POLL_INTERVAL_MS   = parseInt(process.env.POLL_INTERVAL_MS) || 10000;
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 8000;
const DOWN_AFTER_FAILS   = parseInt(process.env.DOWN_AFTER_FAILS) || 3;
const NOTIFY_CLOSED      = (process.env.NOTIFY_CLOSED || "true").toLowerCase() !== "false";
const CLOSED_AFTER_MISSES = 2; // position must be absent this many polls in a row
const MAX_BODY_BYTES     = 5 * 1024 * 1024;

let ACCOUNTS = [];
try {
  const parsed = JSON.parse(process.env.ACCOUNTS || "[]");
  if (Array.isArray(parsed)) ACCOUNTS = parsed.filter((a) => a && a.label && a.url);
  else console.error('[Watcher] ACCOUNTS must be a JSON ARRAY, e.g. [{"label":"FTMO","url":"..."}]');
} catch (e) {
  console.error(`[Watcher] Failed to parse ACCOUNTS env var as JSON: ${e.message}`);
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("[Watcher] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — alerts cannot be sent.");
}
if (!ACCOUNTS.length) {
  console.error("[Watcher] ACCOUNTS is empty or invalid — nothing to watch.");
}

// Per-account state (in memory; resets on redeploy)
const state = new Map(); // label -> { positions: Map(id -> {pos, misses}), initialized, fails, down }
function getState(label) {
  if (!state.has(label)) {
    state.set(label, { positions: new Map(), initialized: false, fails: 0, down: false });
  }
  return state.get(label);
}

const esc = (s) =>
  String(s == null ? "--" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── JSON GET with hard timeout and size cap ─────────────────────────
function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const req = lib.get(url, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); // discard body so the socket is freed
        return done(reject, new Error(`HTTP ${res.statusCode}`));
      }
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          req.destroy(new Error("response too large"));
        }
      });
      res.on("end", () => {
        try {
          done(resolve, JSON.parse(body));
        } catch (e) {
          done(reject, new Error(`invalid JSON: ${e.message}`));
        }
      });
      res.on("error", (e) => done(reject, e));
    });

    const timer = setTimeout(() => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on("error", (e) => done(reject, e));
  });
}

// ── Telegram (raw https, with timeout) ──────────────────────────────
function telegramSendMessage(text) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return reject(new Error("Telegram not configured"));
    const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" });
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
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
          else reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Telegram timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function notify(text, logCtx) {
  try {
    await telegramSendMessage(text);
  } catch (e) {
    console.error(`[Watcher] ${logCtx}: failed to send Telegram message — ${e.message}`);
  }
}

// ── Message formatting ──────────────────────────────────────────────
function formatAlert(label, pos) {
  const fmt = (n, d = 2) => (n == null || isNaN(Number(n)) ? "--" : Number(n).toFixed(d));
  const priceDp = pos.assetType === "index" ? 2 : 4;
  const dirIcon = pos.direction === "buy" ? "🟢 BUY" : "🔴 SELL";
  return [
    `<b>[${esc(label)}] ${esc(pos.symbol)} ${dirIcon}</b>`,
    ``,
    `Entry: <b>${fmt(pos.entry, priceDp)}</b>`,
    `SL: ${fmt(pos.sl, priceDp)}  |  TP: ${fmt(pos.tp, priceDp)}`,
    ``,
    `Lots: <b>${fmt(pos.lots, 2)}</b>`,
    `Risk: <b>€${fmt(pos.riskEur)}</b>`,
    ``,
    `Session: ${esc(pos.session || "--")}  |  ${esc(pos.dailyLabel || "")}`,
    `ID: ${esc(pos.positionId)}`,
  ].join("\n");
}

function formatClosed(label, pos) {
  const fmt = (n, d = 2) => (n == null || isNaN(Number(n)) ? "--" : Number(n).toFixed(d));
  const priceDp = pos.assetType === "index" ? 2 : 4;
  const dir = pos.direction === "buy" ? "BUY" : "SELL";
  return [
    `⚪ <b>[${esc(label)}] ${esc(pos.symbol)} ${dir} closed</b>`,
    `Entry was ${fmt(pos.entry, priceDp)}  |  SL ${fmt(pos.sl, priceDp)}  |  TP ${fmt(pos.tp, priceDp)}`,
    `ID: ${esc(pos.positionId)}`,
  ].join("\n");
}

// ── Poll one account ────────────────────────────────────────────────
async function pollAccount(account) {
  const { label, url } = account;
  const st = getState(label);

  let positions;
  try {
    positions = await fetchJson(`${url.replace(/\/$/, "")}/api/open-positions`);
    if (!Array.isArray(positions)) throw new Error("response is not an array");
  } catch (e) {
    st.fails++;
    // log only the first failure and then every 30th, to avoid log spam
    if (st.fails === 1 || st.fails % 30 === 0) {
      console.error(`[Watcher] ${label}: fetch failed (${st.fails}x in a row) — ${e.message}`);
    }
    if (st.fails >= DOWN_AFTER_FAILS && !st.down) {
      st.down = true;
      await notify(`⚠️ <b>[${esc(label)}] unreachable</b>\n${esc(e.message)}\nNo alerts for this account until it recovers.`, label);
    }
    return;
  }

  if (st.down) {
    st.down = false;
    console.log(`[Watcher] ${label}: recovered`);
    await notify(`✅ <b>[${esc(label)}] reachable again</b>`, label);
  }
  st.fails = 0;

  const currentIds = new Set(positions.map((p) => String(p.positionId)));

  // First successful poll: record what's already open, no alerts
  if (!st.initialized) {
    positions.forEach((p) => st.positions.set(String(p.positionId), { pos: p, misses: 0 }));
    st.initialized = true;
    console.log(`[Watcher] ${label}: initialized with ${positions.length} existing open position(s)`);
    return;
  }

  // New positions
  for (const pos of positions) {
    const id = String(pos.positionId);
    const known = st.positions.get(id);
    if (!known) {
      st.positions.set(id, { pos, misses: 0 });
      await notify(formatAlert(label, pos), label);
      console.log(`[Watcher] ${label}: alert sent for new position ${id}`);
    } else {
      known.pos = pos; // keep latest data for the closed message
      known.misses = 0;
    }
  }

  // Closed positions (absent for CLOSED_AFTER_MISSES polls in a row)
  for (const [id, entry] of st.positions) {
    if (currentIds.has(id)) continue;
    entry.misses++;
    if (entry.misses >= CLOSED_AFTER_MISSES) {
      st.positions.delete(id);
      console.log(`[Watcher] ${label}: position ${id} closed`);
      if (NOTIFY_CLOSED) await notify(formatClosed(label, entry.pos), label);
    }
  }
}

// ── Main loop: parallel per round, next round only after this one ends
async function loop() {
  try {
    await Promise.all(
      ACCOUNTS.map((a) =>
        pollAccount(a).catch((e) => console.error(`[Watcher] ${a.label}: unexpected error — ${e.message}`))
      )
    );
  } catch (e) {
    console.error(`[Watcher] loop error — ${e.message}`);
  }
  setTimeout(loop, POLL_INTERVAL_MS);
}

console.log(`[Watcher] Starting — ${ACCOUNTS.length} account(s), poll every ${POLL_INTERVAL_MS}ms, timeout ${REQUEST_TIMEOUT_MS}ms`);
ACCOUNTS.forEach((a) => console.log(`[Watcher]   - ${a.label} → ${a.url}`));
loop();

// ── Minimal healthcheck server ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    const accounts = ACCOUNTS.map((a) => {
      const st = getState(a.label);
      return { label: a.label, down: st.down, open: st.positions.size, initialized: st.initialized };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, pollIntervalMs: POLL_INTERVAL_MS, accounts, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  })
  .listen(PORT, () => console.log(`[Watcher] Healthcheck server listening on :${PORT}`));

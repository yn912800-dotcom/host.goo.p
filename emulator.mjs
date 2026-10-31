// TEST HARNESS ONLY — local Telegram Bot API emulator used by tests/telegram/e2e.mjs.
// Implements getMe / getUpdates (long polling) / sendMessage / deleteWebhook over real HTTP,
// and lets the test inject network failures. It is NOT used by the platform at runtime.
//
//   Bot API:  http://127.0.0.1:8081/bot<token>/<method>
//   Control:  http://127.0.0.1:8082   (push, outage, state, reset)
import http from "node:http";

const API_PORT = Number(process.env.TG_EMU_PORT || 8081);
const CTRL_PORT = Number(process.env.TG_EMU_CTRL_PORT || 8082);

/** per-token state */
const bots = new Map();
let outage = { mode: "none", until: 0 }; // none | reset | hang | 502
const sockets = new Set();
const hung = new Set();
let nextUpdateId = 1000;
let nextMsgId = 1;

function bot(token) {
  let b = bots.get(token);
  if (!b) {
    b = { updates: [], sent: [], waiters: new Set(), active: 0, maxConcurrent: 0, calls: {}, polls: 0 };
    bots.set(token, b);
  }
  return b;
}

function outageActive() {
  if (outage.mode !== "none" && Date.now() > outage.until) endOutage();
  return outage.mode !== "none";
}
function endOutage() {
  outage = { mode: "none", until: 0 };
  for (const res of hung) res.socket?.destroy();
  hung.clear();
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function readParams(req, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = req.headers["content-type"] || "";
  if (raw) {
    if (ct.includes("json")) Object.assign(params, JSON.parse(raw));
    else Object.assign(params, Object.fromEntries(new URLSearchParams(raw).entries()));
  }
  return params;
}

const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (outageActive()) {
    if (outage.mode === "reset") return req.socket.destroy();
    if (outage.mode === "hang") return void hung.add(res); // never answers → client timeout
    if (outage.mode === "502") {
      res.writeHead(502, { "content-type": "text/html" });
      return res.end("<html><body>502 Bad Gateway</body></html>");
    }
  }
  const m = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
  if (!m) return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  const [, token, method] = m;
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return json(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
  const b = bot(token);
  b.calls[method] = (b.calls[method] || 0) + 1;
  let p;
  try {
    p = await readParams(req, url);
  } catch {
    return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: can't parse JSON" });
  }

  switch (method) {
    case "getMe":
      return json(res, 200, { ok: true, result: { id: Number(token.split(":")[0]), is_bot: true, first_name: "•-تــيــ۾ إڪـXـس-• Test Bot", username: `arena_test_${token.split(":")[0]}_bot` } });
    case "deleteWebhook":
      if (p.drop_pending_updates === true || p.drop_pending_updates === "true" || p.drop_pending_updates === "True") b.updates = [];
      return json(res, 200, { ok: true, result: true });
    case "sendMessage": {
      const msg = { message_id: nextMsgId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: "private" }, text: String(p.text ?? "") };
      b.sent.push({ chat_id: Number(p.chat_id), text: msg.text, at: Date.now() });
      return json(res, 200, { ok: true, result: msg });
    }
    case "getUpdates": {
      const offset = Number(p.offset || 0);
      const timeout = Math.min(Number(p.timeout || 0), 25);
      if (offset > 0) b.updates = b.updates.filter((u) => u.update_id >= offset);
      const ready = () => (offset < 0 ? b.updates.slice(offset) : b.updates);
      b.polls++;
      b.active++;
      b.maxConcurrent = Math.max(b.maxConcurrent, b.active);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        b.active--;
        b.waiters.delete(waiter);
        clearTimeout(timer);
        if (!res.writableEnded && !res.destroyed) json(res, 200, { ok: true, result: ready() });
      };
      const waiter = finish;
      const timer = setTimeout(finish, timeout * 1000);
      res.on("close", () => {
        if (!done) {
          done = true;
          b.active--;
          b.waiters.delete(waiter);
          clearTimeout(timer);
        }
      });
      if (ready().length > 0 || timeout === 0) return finish();
      b.waiters.add(waiter);
      return;
    }
    default:
      return json(res, 200, { ok: true, result: true });
  }
});
api.on("connection", (s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});

const ctrl = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = req.method === "POST" ? await readParams(req, url) : Object.fromEntries(url.searchParams.entries());
  if (url.pathname === "/push") {
    const b = bot(p.token);
    const uid = Number(p.user_id || 777000);
    b.updates.push({
      update_id: nextUpdateId++,
      message: { message_id: nextMsgId++, date: Math.floor(Date.now() / 1000), from: { id: uid, is_bot: false, first_name: "Tester" }, chat: { id: uid, type: "private", first_name: "Tester" }, text: String(p.text) },
    });
    for (const w of [...b.waiters]) w();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/outage") {
    if (p.mode === "none") endOutage();
    else {
      outage = { mode: p.mode, until: Date.now() + Number(p.ms || 10000) };
      if (p.mode !== "hang") for (const s of sockets) s.destroy(); // drop in-flight long polls
    }
    return json(res, 200, { ok: true, outage });
  }
  if (url.pathname === "/state") {
    const b = bot(p.token);
    return json(res, 200, { sent: b.sent, active: b.active, maxConcurrent: b.maxConcurrent, polls: b.polls, calls: b.calls, outage: outageActive() ? outage.mode : "none" });
  }
  if (url.pathname === "/reset-concurrency") {
    const b = bot(p.token);
    b.maxConcurrent = b.active;
    return json(res, 200, { ok: true, active: b.active });
  }
  json(res, 404, { error: "unknown" });
});

api.listen(API_PORT, "127.0.0.1", () => console.log(`[emulator] Bot API on :${API_PORT}`));
ctrl.listen(CTRL_PORT, "127.0.0.1", () => console.log(`[emulator] control on :${CTRL_PORT}`));

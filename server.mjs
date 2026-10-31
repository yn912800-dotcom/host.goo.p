import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8787);
const SHARED_SECRET = process.env.WORKER_SHARED_SECRET;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const usedRequests = new Map();
const requestRates = new Map();
const allowedActions = new Set(["start", "stop", "restart", "kill"]);

if (!SHARED_SECRET || SHARED_SECRET.length < 32) {
  console.error("WORKER_SHARED_SECRET must be at least 32 characters");
  process.exit(1);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticate(req, body) {
  const timestamp = req.headers["x-worker-timestamp"];
  const requestId = req.headers["x-worker-request-id"];
  const signature = req.headers["x-worker-signature"];
  if (!timestamp || !requestId || !signature) return false;
  const time = Number(timestamp);
  if (!Number.isSafeInteger(time) || Math.abs(Date.now() - time) > MAX_CLOCK_SKEW_MS) return false;
  if (usedRequests.has(requestId)) return false;
  const canonical = `${req.method}\n${req.url}\n${timestamp}\n${requestId}\n${body}`;
  const expected = crypto.createHmac("sha256", SHARED_SECRET).update(canonical).digest("hex");
  if (!safeEqual(signature, expected)) return false;
  usedRequests.set(requestId, Date.now() + MAX_CLOCK_SKEW_MS);
  return true;
}

function docker(args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("docker command timed out")); }, timeout);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `docker exited ${code}`)); });
  });
}

const server = http.createServer(async (req, res) => {
  const address = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const rate = requestRates.get(address);
  if (!rate || now - rate.startedAt >= RATE_WINDOW_MS) {
    requestRates.set(address, { startedAt: now, count: 1 });
  } else if (++rate.count > RATE_LIMIT) {
    return json(res, 429, { error: "Worker rate limit exceeded" });
  }

  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    req.resume();
    return json(res, 413, { error: "Request body too large" });
  }
  const chunks = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!authenticate(req, body)) return json(res, 401, { error: "Invalid worker authentication" });
  try {
    if (req.method === "GET" && req.url === "/v1/health") {
      const info = await docker(["info", "--format", "{{.ServerVersion}}"]);
      return json(res, 200, { ok: true, docker: info });
    }
    const match = req.url?.match(/^\/v1\/servers\/([a-f0-9-]+)(?:\/(start|stop|restart|kill|status))?$/i);
    if (!match) return json(res, 404, { error: "Not found" });
    const [, serverId, action = "status"] = match;
    const container = `tiimx-${serverId}`;
    if (action === "status") {
      const output = await docker(["inspect", "--format", "{{json .State}}", container]);
      return json(res, 200, { serverId, state: JSON.parse(output) });
    }
    if (!allowedActions.has(action)) return json(res, 400, { error: "Unsupported action" });
    if (action === "start") await docker(["start", container]);
    if (action === "stop") await docker(["stop", "--time", "10", container]);
    if (action === "restart") await docker(["restart", "--time", "10", container]);
    if (action === "kill") await docker(["kill", container]);
    return json(res, 202, { ok: true, serverId, action });
  } catch (error) {
    return json(res, 503, { error: error instanceof Error ? error.message : "Worker unavailable" });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, expires] of usedRequests) if (expires <= now) usedRequests.delete(id);
  for (const [ip, rate] of requestRates) if (now - rate.startedAt >= RATE_WINDOW_MS) requestRates.delete(ip);
}, 60_000).unref();

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(PORT, "0.0.0.0", () => console.log(`Runtime Worker listening on ${PORT}`));

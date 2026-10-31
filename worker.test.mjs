import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secret = "worker-test-secret-that-is-at-least-32-characters";

async function getUnusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  const { port } = address;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sign(method, requestPath, body = "", requestId = crypto.randomUUID()) {
  const timestamp = String(Date.now());
  const canonical = `${method}\n${requestPath}\n${timestamp}\n${requestId}\n${body}`;
  return {
    requestId,
    headers: {
      "x-worker-timestamp": timestamp,
      "x-worker-request-id": requestId,
      "x-worker-signature": crypto.createHmac("sha256", secret).update(canonical).digest("hex"),
    },
  };
}

test("worker authenticates HMAC requests, blocks replay, and dispatches safe Docker lifecycle calls", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "teamx-worker-test-"));
  const binDir = path.join(temp, "bin");
  const dockerLog = path.join(temp, "docker.log");
  await fs.mkdir(binDir);
  const dockerShim = path.join(binDir, "docker");
  await fs.writeFile(dockerShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\nif [ "$1" = "info" ]; then echo '27.1.0'; fi\nif [ "$1" = "inspect" ]; then echo '{"Running":true}'; fi\n`, { mode: 0o755 });
  const port = await getUnusedPort();
  const child = spawn(process.execPath, [path.join(root, "worker/server.mjs")], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PORT: String(port), WORKER_SHARED_SECRET: secret, DOCKER_LOG: dockerLog },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
    await fs.rm(temp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Worker exited early: ${output}`);
    try {
      await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(300) });
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(ready, true, `Worker did not start: ${output}`);

  const unauthenticated = await fetch(`${base}/v1/health`);
  assert.equal(unauthenticated.status, 401);

  const healthPath = "/v1/health";
  const badSignature = sign("GET", healthPath);
  badSignature.headers["x-worker-signature"] = "0".repeat(64);
  assert.equal((await fetch(`${base}${healthPath}`, { headers: badSignature.headers })).status, 401);

  const valid = sign("GET", healthPath);
  const health = await fetch(`${base}${healthPath}`, { headers: valid.headers });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, docker: "27.1.0" });
  assert.equal((await fetch(`${base}${healthPath}`, { headers: valid.headers })).status, 401, "replayed request id must be rejected");

  const id = "123e4567-e89b-12d3-a456-426614174000";
  const statusPath = `/v1/servers/${id}`;
  const statusReq = sign("GET", statusPath);
  const status = await fetch(`${base}${statusPath}`, { headers: statusReq.headers });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).state, { Running: true });

  const startPath = `/v1/servers/${id}/start`;
  const startReq = sign("GET", startPath);
  const started = await fetch(`${base}${startPath}`, { headers: startReq.headers });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).action, "start");
  const dockerCalls = await fs.readFile(dockerLog, "utf8");
  assert.match(dockerCalls, /start tiimx-123e4567-e89b-12d3-a456-426614174000/);

  const tooLarge = await fetch(`${base}/v1/health`, { method: "POST", body: "x".repeat(65 * 1024) });
  assert.equal(tooLarge.status, 413);
});

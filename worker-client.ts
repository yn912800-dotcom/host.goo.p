import crypto from "node:crypto";

export type WorkerAction = "start" | "stop" | "restart" | "kill" | "status";

export function workerConfigured(): boolean {
  return Boolean(process.env.RUNTIME_WORKER_URL && process.env.WORKER_SHARED_SECRET);
}

export async function workerRequest(serverId: string, action: WorkerAction) {
  const base = process.env.RUNTIME_WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) throw new Error("Runtime Worker is not configured");
  if (secret.length < 32) throw new Error("WORKER_SHARED_SECRET is too short");
  const path = `/v1/servers/${encodeURIComponent(serverId)}/${action}`;
  const timestamp = String(Date.now());
  const requestId = crypto.randomUUID();
  const canonical = `GET\n${path}\n${timestamp}\n${requestId}\n`;
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  const response = await fetch(`${base}${path}`, {
    headers: {
      "x-worker-timestamp": timestamp,
      "x-worker-request-id": requestId,
      "x-worker-signature": signature,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Runtime Worker request failed (${response.status})`);
  return data as Record<string, unknown>;
}

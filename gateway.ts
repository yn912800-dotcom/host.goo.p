import { db } from "@/db";
import { files as filesTbl, servers } from "@/db/schema";
import { normalizePath, getMimeType } from "@/lib/utils";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

/**
 * Public gateway for hosted projects:  /apps/<serverId>/<path>
 *  - static runtime → served straight from the project files
 *  - other runtimes → reverse-proxied to the project's process on 127.0.0.1:<PORT>
 *    (this is the URL to use for webhooks, e.g. WhatsApp Cloud API / Telegram webhooks)
 *
 * User content is isolated from the platform origin with a `sandbox` CSP (opaque origin →
 * no access to platform cookies / APIs) and Set-Cookie headers are stripped.
 */
const ISOLATION_HEADERS: Record<string, string> = {
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "cookie", "content-length", "accept-encoding",
]);

export type GatewayCtx = { params: Promise<{ id: string; path?: string[] }> };

export async function gatewayHandler(req: NextRequest, ctx: GatewayCtx): Promise<Response> {
  const { id, path: parts } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return text(404, "Not found");
  const [srv] = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  if (!srv) return text(404, "App not found");
  if (srv.status !== "RUNNING") return text(503, `App is not running (status: ${srv.status})`);

  let rel: string;
  try {
    rel = normalizePath((parts ?? []).map((p) => decodeURIComponent(p)).join("/"));
  } catch {
    return text(400, "Invalid path");
  }

  // Ensure relative asset URLs resolve under /apps/<id>/
  if (!parts?.length && !req.nextUrl.pathname.endsWith("/")) {
    const u = req.nextUrl.clone();
    u.pathname = req.nextUrl.pathname + "/";
    return Response.redirect(u, 308);
  }

  if (srv.runtime === "static") return serveStatic(id, rel, req.method);
  if (!srv.port) return text(502, "App has no port assigned");

  const target = `http://127.0.0.1:${srv.port}/${rel}${req.nextUrl.search}`;
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  });
  headers.set("x-forwarded-host", req.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", req.nextUrl.protocol.replace(":", ""));
  headers.set("x-forwarded-prefix", `/apps/${id}`);

  try {
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const out = new Headers();
    res.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.has(key) || key === "set-cookie" || key === "content-encoding") return;
      out.set(k, key === "location" && v.startsWith("/") ? `/apps/${id}${v}` : v);
    });
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) out.set(k, v);
    return new Response(req.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "TimeoutError"
        ? "App did not respond in 30s"
        : "App is not accepting HTTP connections on its PORT";
    return text(502, msg);
  }
}

async function serveStatic(serverId: string, rel: string, method: string): Promise<Response> {
  const candidates = rel ? [rel, `${rel}/index.html`] : ["index.html"];
  for (const p of candidates) {
    const [f] = await db
      .select()
      .from(filesTbl)
      .where(and(eq(filesTbl.serverId, serverId), eq(filesTbl.path, p)))
      .limit(1);
    if (!f || f.isDirectory) continue;
    const body =
      f.isBinary && f.binaryContent ? Buffer.from(f.binaryContent, "base64") : Buffer.from(f.content ?? "", "utf8");
    const mime = getMimeType(p);
    const type =
      mime.startsWith("text/") || mime.includes("javascript") || mime === "application/json"
        ? `${mime}; charset=utf-8`
        : mime;
    return new Response(method === "HEAD" ? null : new Uint8Array(body), {
      status: 200,
      headers: { "content-type": type, ...ISOLATION_HEADERS },
    });
  }
  return text(404, "File not found");
}

function text(status: number, msg: string) {
  return new Response(msg, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...ISOLATION_HEADERS },
  });
}

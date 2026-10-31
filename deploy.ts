/**
 * •-تــيــ۾ إڪـXـس-• process manager — REAL execution engine.
 *
 * Each project ("server") gets its own workspace directory on disk. A deployment:
 *   1. syncs the project files from Postgres → workspace (symlink / traversal safe)
 *   2. installs dependencies for real (pip --target / npm / composer), cached by manifest hash
 *   3. runs an optional build command
 *   4. spawns the start command as a separate process group (no shell, allow-listed executables)
 *   5. health-checks the process (alive after startup window, optional TCP port probe)
 *
 * stdout / stderr are streamed line-by-line into `server_logs` (batched, rate-limited, secrets redacted).
 * A monitor samples real CPU / RSS from /proc for the whole process tree every 10s, enforces the
 * plan's RAM limit (OOM kill), and writes `server_metrics` with retention.
 * Crashes trigger auto-restart with exponential back-off and crash-loop protection.
 *
 * Isolation note: this runs projects as OS processes with a clean environment, per-project
 * working directory, prlimit (fsize / nofile / core) and a RAM watchdog. On a production VPS the
 * same lifecycle is meant to be backed by Docker containers (see ARCHITECTURE in README).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import { db } from "@/db";
import {
  deployments,
  environmentVariables,
  files as filesTbl,
  ports,
  serverLogs,
  serverMetrics,
  servers,
} from "@/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { notify } from "./activity";

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(process.cwd(), ".data", "servers")
);
const NPM_CACHE = path.join(os.tmpdir(), "arenahost-npm-cache");
const MANIFEST = ".arenahost-manifest.json";
const DEPS_HASH = ".arenahost-deps.sha256";
const CRASH_WINDOW_MS = 120_000;
const CRASH_LIMIT = 5;
const STARTUP_WINDOW_MS = 3_500;
const MONITOR_INTERVAL_MS = 10_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_LOG_LINES_PER_SEC = 200;
const LOG_KEEP_PER_SERVER = 5000;
const CLK_TCK = 100;
const PAGE_SIZE = 4096;

type Level = "INFO" | "WARNING" | "ERROR";
type LogRow = {
  createdAt?: Date;
  serverId: string;
  deploymentId: string | null;
  level: Level;
  source: string;
  message: string;
};
type Proc = {
  child: ChildProcess;
  startedAt: number;
  stopping: boolean;
  exited: boolean;
  phase: "starting" | "running";
  ramLimitMb: number;
  prevCpu?: { ticks: number; at: number };
};
type PMState = {
  procs: Map<string, Proc>;
  busy: Set<string>;
  crashes: Map<string, number[]>;
  secrets: Map<string, string[]>;
  logBuf: LogRow[];
  logRate: Map<string, { sec: number; count: number; dropped: number }>;
  flushTimer: NodeJS.Timeout | null;
  monitorTimer: NodeJS.Timeout | null;
  diskCache: Map<string, { mb: number; at: number }>;
  bins: Map<string, string | null>;
  lastTrim: number;
  recovered: boolean;
  exitHook: boolean;
};

const g = globalThis as typeof globalThis & { __arenahostPM?: PMState };
const pm: PMState = (g.__arenahostPM ??= {
  procs: new Map(),
  busy: new Set(),
  crashes: new Map(),
  secrets: new Map(),
  logBuf: [],
  logRate: new Map(),
  flushTimer: null,
  monitorTimer: null,
  diskCache: new Map(),
  bins: new Map(),
  lastTrim: 0,
  recovered: false,
  exitHook: false,
});

// Kill every managed process group when the platform itself shuts down (no orphans).
if (!pm.exitHook) {
  pm.exitHook = true;
  const killAll = () => {
    for (const p of pm.procs.values()) {
      p.stopping = true;
      if (p.child.pid) {
        try {
          process.kill(-p.child.pid, "SIGKILL");
        } catch {}
      }
    }
  };
  process.on("exit", killAll);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      killAll();
      if (process.listenerCount(sig) === 0) process.exit(0);
    });
  }
}

// ───────────────────────── binaries ─────────────────────────
/** Project-local runtimes (e.g. static PHP) survive environment rebuilds. */
export const RUNTIMES_BIN = path.join(process.cwd(), ".runtimes", "bin");
const CA_BUNDLE = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find((p) => fs.existsSync(p));
const SEARCH_PATH = Array.from(
  new Set([RUNTIMES_BIN, ...(process.env.PATH ?? "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"])
).filter(Boolean);

export function clearBinaryCache() {
  pm.bins.clear();
}

let phpInstalling: Promise<boolean> | null = null;
/**
 * Self-heal: if no PHP binary exists on this node, download the official static PHP CLI build
 * (static-php-cli, includes curl/openssl/pcntl/mbstring) into .runtimes/bin. No shell is used.
 */
export function ensurePhpRuntime(): Promise<boolean> {
  if (findBinary("php")) return Promise.resolve(true);
  if (phpInstalling) return phpInstalling;
  phpInstalling = (async () => {
    try {
      const base = "https://dl.static-php.dev/static-php-cli/common/";
      const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
      const listing = await (await fetch(base, { signal: AbortSignal.timeout(20_000) })).text();
      const re = new RegExp(`php-8\\.3\\.(\\d+)-cli-linux-${arch}\\.tar\\.gz`, "g");
      const patches = [...listing.matchAll(re)].map((m) => Number(m[1]));
      if (!patches.length) throw new Error("no static PHP build found");
      const file = `php-8.3.${Math.max(...patches)}-cli-linux-${arch}.tar.gz`;
      const res = await fetch(base + file, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      await fsp.mkdir(RUNTIMES_BIN, { recursive: true });
      const tgz = path.join(os.tmpdir(), file);
      await fsp.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
      execFileSync(findBinary("tar") ?? "/bin/tar", ["-xzf", tgz, "-C", RUNTIMES_BIN, "php"], { timeout: 60_000 });
      await fsp.chmod(path.join(RUNTIMES_BIN, "php"), 0o755);
      await fsp.rm(tgz, { force: true });
      const composer = await fetch("https://getcomposer.org/download/latest-stable/composer.phar", { signal: AbortSignal.timeout(60_000) });
      if (composer.ok) await fsp.writeFile(path.join(RUNTIMES_BIN, "composer.phar"), Buffer.from(await composer.arrayBuffer()));
      clearBinaryCache();
      console.log(`[runtimes] installed static ${file}`);
      return !!findBinary("php");
    } catch (e) {
      console.error("[runtimes] PHP auto-install failed:", errMsg(e));
      return false;
    } finally {
      phpInstalling = null;
    }
  })();
  return phpInstalling;
}

export function findBinary(name: string): string | null {
  if (pm.bins.has(name)) return pm.bins.get(name)!;
  let found: string | null = null;
  for (const dir of SEARCH_PATH) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      found = p;
      break;
    } catch {}
  }
  pm.bins.set(name, found);
  return found;
}

/** Returns e.g. "22.23.2" for node, "3.11.2" for python, "8.2.33" for php. */
export function binaryVersion(bin: string, args: string[] = ["--version"]): string | null {
  const p = findBinary(bin);
  if (!p) return null;
  try {
    const out = execFileSync(p, args, { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const m = out.match(/(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ───────────────────────── logging ─────────────────────────
const TG_TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function redact(serverId: string, msg: string): string {
  let out = msg.replace(TG_TOKEN_RE, "***").replace(BEARER_RE, "$1***");
  for (const s of pm.secrets.get(serverId) ?? []) {
    if (s && out.includes(s)) out = out.split(s).join("***");
  }
  return out;
}

export function log(
  serverId: string,
  message: string,
  source = "system",
  level: Level = "INFO",
  deploymentId: string | null = null
) {
  const sec = Math.floor(Date.now() / 1000);
  let r = pm.logRate.get(serverId);
  if (!r || r.sec !== sec) {
    if (r && r.dropped > 0) {
      pm.logBuf.push({
        serverId,
        deploymentId: null,
        level: "WARNING",
        source: "system",
        message: `${r.dropped} log lines dropped (rate limit ${MAX_LOG_LINES_PER_SEC}/s)`,
      });
    }
    r = { sec, count: 0, dropped: 0 };
    pm.logRate.set(serverId, r);
  }
  if (++r.count > MAX_LOG_LINES_PER_SEC) {
    r.dropped++;
    return;
  }
  pm.logBuf.push({
    createdAt: new Date(),
    serverId,
    deploymentId,
    level,
    source,
    message: redact(serverId, message.replace(ANSI_RE, "")).slice(0, 4000),
  });
  if (!pm.flushTimer) {
    pm.flushTimer = setTimeout(() => {
      pm.flushTimer = null;
      void flushLogs();
    }, 300);
  }
}

export async function flushLogs() {
  if (pm.logBuf.length === 0) return;
  const batch = pm.logBuf.splice(0, pm.logBuf.length);
  try {
    for (let i = 0; i < batch.length; i += 500) {
      await db.insert(serverLogs).values(batch.slice(i, i + 500));
    }
  } catch {
    // A server may have been deleted mid-batch (FK). Insert row by row, skipping failures.
    for (const row of batch) {
      await db.insert(serverLogs).values(row).catch(() => {});
    }
  }
}

function classify(line: string): Level {
  if (/\b(error|exception|traceback|fatal|unhandled|ERR!)\b/i.test(line)) return "ERROR";
  if (/\b(warn|warning|deprecat)/i.test(line)) return "WARNING";
  return "INFO";
}

function pipeLines(stream: Readable | null | undefined, onLine: (l: string) => void) {
  if (!stream) return;
  stream.setEncoding("utf8");
  let rest = "";
  stream.on("data", (chunk: string) => {
    rest += chunk;
    const parts = rest.split(/\r?\n|\r/);
    rest = parts.pop() ?? "";
    if (rest.length > 8000) {
      parts.push(rest);
      rest = "";
    }
    for (const p of parts) if (p.trim()) onLine(p);
  });
  stream.on("end", () => {
    if (rest.trim()) onLine(rest);
    rest = "";
  });
  stream.on("error", () => {});
}

// ───────────────────────── commands ─────────────────────────
const FORBIDDEN = /[;&|<>`$\\]/;
const ALLOWED: Record<string, string[]> = {
  python: ["python3"],
  python3: ["python3"],
  pip: ["python3", "-m", "pip"],
  pip3: ["python3", "-m", "pip"],
  node: ["node"],
  npm: ["npm"],
  npx: ["npx"],
  php: ["php"],
  composer: ["composer"],
  deno: ["deno"],
  go: ["go"],
  ruby: ["ruby"],
  bundle: ["bundle"],
  java: ["java"],
  cargo: ["cargo"],
  bash: ["bash"],
  sh: ["sh"],
};

/** Tokenize a command WITHOUT a shell. Only $VAR substitution for known vars; shell operators rejected. */
export function parseCommand(cmd: string, vars: Record<string, string>): string[] {
  const s = cmd
    .trim()
    .replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, k: string) => (k in vars ? vars[k] : m));
  if (FORBIDDEN.test(s))
    throw new Error(
      "Shell operators (; & | < > ` $ \\) are not allowed in commands. Put complex logic in a script file or a package.json script."
    );
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) throw new Error("Unbalanced quotes in command");
  if (cur || has) out.push(cur);
  if (out.length === 0) throw new Error("Empty command");
  return out;
}

function resolveArgv(tokens: string[], runtime: string, mode: "install" | "start"): string[] {
  const head = tokens[0];
  const mapped = ALLOWED[head];
  if (!mapped)
    throw new Error(
      `"${head}" is not an allowed executable. Allowed: ${Object.keys(ALLOWED).join(", ")}`
    );
  if ((head === "bash" || head === "sh") && runtime !== "shell")
    throw new Error("bash/sh is only allowed for the Shell runtime");
  let bin = findBinary(mapped[0]);
  let prefix = mapped.slice(1);
  if (!bin && head === "composer" && fs.existsSync(path.join(RUNTIMES_BIN, "composer.phar")) && findBinary("php")) {
    bin = findBinary("php")!;
    prefix = [path.join(RUNTIMES_BIN, "composer.phar")];
  }
  if (!bin) throw new Error(`${mapped[0]} is not installed on this node`);
  const args = [...prefix, ...tokens.slice(1)];
  // PHP: make HTTPS work for static builds (system CA bundle)
  if (path.basename(bin) === "php" && CA_BUNDLE) {
    args.unshift("-d", `curl.cainfo=${CA_BUNDLE}`, "-d", `openssl.cafile=${CA_BUNDLE}`);
  }
  if (mode === "install" && (head === "pip" || head === "pip3") && args[2] === "install") {
    // python3 -m pip install ... → isolate into the project's .packages dir
    if (!args.includes("--target") && !args.includes("-t")) args.push("--target", ".packages", "--upgrade");
    if (!args.includes("--disable-pip-version-check")) args.push("--disable-pip-version-check");
    if (!args.includes("--no-cache-dir")) args.push("--no-cache-dir");
  }
  if (mode === "install" && head === "npm" && ["install", "i", "ci"].includes(args[0] ?? "")) {
    args.push("--no-audit", "--no-fund");
  }
  return [bin, ...args];
}

function display(argv: string[]): string {
  return [path.basename(argv[0]), ...argv.slice(1)]
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ");
}

function wrapLimits(argv: string[], storageMb: number): string[] {
  const pl = findBinary("prlimit");
  if (!pl) return argv;
  const fsize = Math.max(64, storageMb) * 1024 * 1024;
  return [pl, "--nofile=4096", "--core=0", `--fsize=${fsize}`, "--", ...argv];
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {}
  }
}

// ───────────────────────── workspace ─────────────────────────
export function workspaceDir(serverId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(serverId)) throw new Error("Invalid server id");
  return path.join(DATA_DIR, serverId);
}

/** Resolve a relative project path inside root, removing any symlinks on the way (anti symlink-abuse). */
async function safeTarget(root: string, rel: string): Promise<string> {
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep)) throw new Error(`Unsafe path: ${rel}`);
  let cur = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    const st = await fsp.lstat(cur).catch(() => null);
    if (st?.isSymbolicLink()) await fsp.unlink(cur);
    else if (st && !st.isDirectory()) await fsp.rm(cur, { force: true });
  }
  return target;
}

async function syncWorkspace(serverId: string, depId: string | null): Promise<string> {
  const root = workspaceDir(serverId);
  await fsp.mkdir(root, { recursive: true });
  const rows = await db
    .select({
      path: filesTbl.path,
      isDirectory: filesTbl.isDirectory,
      content: filesTbl.content,
      binaryContent: filesTbl.binaryContent,
      isBinary: filesTbl.isBinary,
    })
    .from(filesTbl)
    .where(eq(filesTbl.serverId, serverId));

  let prev: string[] = [];
  try {
    prev = JSON.parse(await fsp.readFile(path.join(root, MANIFEST), "utf8"));
  } catch {}
  const now = new Set<string>();
  let written = 0;
  let bytes = 0;
  for (const r of rows) {
    const t = await safeTarget(root, r.path);
    const st = await fsp.lstat(t).catch(() => null);
    if (r.isDirectory) {
      if (st && !st.isDirectory()) await fsp.rm(t, { force: true, recursive: true });
      await fsp.mkdir(t, { recursive: true });
      continue;
    }
    if (st && (st.isSymbolicLink() || st.isDirectory())) await fsp.rm(t, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(t), { recursive: true });
    const data =
      r.isBinary && r.binaryContent
        ? Buffer.from(r.binaryContent, "base64")
        : Buffer.from(r.content ?? "", "utf8");
    await fsp.writeFile(t, data);
    written++;
    bytes += data.length;
    now.add(r.path);
  }
  // Remove files that were deleted in the file manager since the last sync
  // (runtime-created files such as sessions / databases are preserved).
  for (const p of prev) {
    if (now.has(p)) continue;
    try {
      await fsp.rm(await safeTarget(root, p), { force: true });
    } catch {}
  }
  await fsp.writeFile(path.join(root, MANIFEST), JSON.stringify([...now]));
  log(serverId, `Synced ${written} files (${(bytes / 1024).toFixed(1)} KB) to workspace`, "system", "INFO", depId);
  return root;
}

// ───────────────────────── env ─────────────────────────
type ServerRow = typeof servers.$inferSelect;

async function buildEnv(srv: ServerRow, forInstall: boolean): Promise<Record<string, string>> {
  const root = workspaceDir(srv.id);
  const rows = await db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.serverId, srv.id));
  const env: Record<string, string> = {
    PATH: [path.join(root, ".packages", "bin"), path.join(root, "node_modules", ".bin"), ...SEARCH_PATH].join(":"),
    HOME: root,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    PORT: String(srv.port ?? ""),
    HOST: "127.0.0.1",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: path.join(root, ".packages"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    COMPOSER_HOME: path.join(os.tmpdir(), "arenahost-composer"),
    COMPOSER_NO_INTERACTION: "1",
    npm_config_cache: NPM_CACHE,
    npm_config_update_notifier: "false",
    ARENAHOST_SERVER_ID: srv.id,
    ARENAHOST_PUBLIC_PATH: `/apps/${srv.id}`,
  };
  if (!forInstall) {
    env.NODE_ENV = "production";
    env.NODE_OPTIONS = `--max-old-space-size=${Math.max(64, Math.floor(srv.ramMb * 0.75))}`;
  }
  const secrets: string[] = [];
  for (const r of rows) {
    if (r.key === "PATH" || r.key === "HOME" || r.key === "PORT") continue;
    env[r.key] = r.value;
    if ((r.isSecret || /TOKEN|SECRET|KEY|PASS/i.test(r.key)) && r.value.length >= 6) secrets.push(r.value);
  }
  pm.secrets.set(srv.id, secrets);
  return env;
}

// ───────────────────────── steps ─────────────────────────
function runStep(
  serverId: string,
  depId: string | null,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  source: string,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve) => {
    log(serverId, `$ ${display(argv)}`, source, "INFO", depId);
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code);
    };
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      log(serverId, `Step timed out after ${timeoutMs / 1000}s — killed`, source, "ERROR", depId);
      killGroup(child, "SIGKILL");
    }, timeoutMs);
    pipeLines(child.stdout, (l) => log(serverId, l, source, "INFO", depId));
    pipeLines(child.stderr, (l) => log(serverId, l, source, classify(l), depId));
    child.on("error", (e) => {
      log(serverId, `Failed to run ${path.basename(argv[0])}: ${e.message}`, source, "ERROR", depId);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

const DEP_FILES: Record<string, string[]> = {
  python: ["requirements.txt", "pyproject.toml"],
  node: ["package.json", "package-lock.json"],
  php: ["composer.json", "composer.lock"],
};
const DEP_DIRS: Record<string, string> = { python: ".packages", node: "node_modules", php: "vendor" };

function defaultInstall(runtime: string, root: string): string | null {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  if (runtime === "python") {
    if (has("requirements.txt")) return "pip install -r requirements.txt";
    if (has("pyproject.toml")) return "pip install .";
  }
  if (runtime === "node" && has("package.json")) return has("package-lock.json") ? "npm ci" : "npm install";
  if (runtime === "php" && has("composer.json")) return "composer install --no-dev --no-interaction --no-progress";
  return null;
}

async function installDeps(srv: ServerRow, root: string, depId: string) {
  const depFiles = DEP_FILES[srv.runtime] ?? [];
  const present = depFiles.filter((f) => fs.existsSync(path.join(root, f)));
  const cmd = srv.installCommand?.trim() || defaultInstall(srv.runtime, root);
  if (!cmd) {
    log(srv.id, "No install step required.", "install", "INFO", depId);
    return;
  }
  if (depFiles.length > 0 && present.length === 0) {
    log(srv.id, `No dependency manifest (${depFiles.join(", ")}) found — skipping install.`, "install", "INFO", depId);
    return;
  }
  const h = crypto.createHash("sha256").update(cmd);
  for (const f of present) h.update(f).update(await fsp.readFile(path.join(root, f)));
  const hash = h.digest("hex");
  const depDir = DEP_DIRS[srv.runtime];
  const prevHash = await fsp.readFile(path.join(root, DEPS_HASH), "utf8").catch(() => "");
  if (prevHash === hash && depDir && fs.existsSync(path.join(root, depDir))) {
    log(srv.id, "Dependencies unchanged — using cached install.", "install", "INFO", depId);
    return;
  }
  const env = await buildEnv(srv, true);
  const argv = resolveArgv(parseCommand(cmd, { PORT: String(srv.port ?? "") }), srv.runtime, "install");
  const code = await runStep(srv.id, depId, argv, root, env, "install", INSTALL_TIMEOUT_MS);
  if (code !== 0) throw new Error(`Dependency install failed (exit code ${code})`);
  await fsp.writeFile(path.join(root, DEPS_HASH), hash);
  log(srv.id, "Dependencies installed successfully.", "install", "INFO", depId);
}

// ───────────────────────── ports ─────────────────────────
export function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}

function portListening(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const t = setTimeout(() => {
      sock.destroy();
      res(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      sock.destroy();
      res(true);
    });
    sock.once("error", () => {
      clearTimeout(t);
      res(false);
    });
  });
}

export async function allocatePort(serverId: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const candidate = 20000 + Math.floor(Math.random() * 10000);
    if (!(await portFree(candidate))) continue;
    const inserted = await db
      .insert(ports)
      .values({ port: candidate, serverId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return candidate;
    const reused = await db
      .update(ports)
      .set({ serverId, allocatedAt: new Date() })
      .where(and(eq(ports.port, candidate), isNull(ports.serverId)))
      .returning();
    if (reused.length > 0) return candidate;
  }
  throw new Error("No free port available");
}

export async function releasePort(serverId: string): Promise<void> {
  await db.delete(ports).where(eq(ports.serverId, serverId));
}

export async function cleanupOrphanPorts() {
  await db.delete(ports).where(isNull(ports.serverId));
}

// ───────────────────────── process lifecycle ─────────────────────────
async function launch(serverId: string, depId: string | null): Promise<Proc> {
  const [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!srv) throw new Error("Server not found");
  if (!srv.startCommand?.trim()) throw new Error("No start command configured");
  const root = workspaceDir(serverId);
  const env = await buildEnv(srv, false);
  let argv = resolveArgv(
    parseCommand(srv.startCommand, { PORT: String(srv.port ?? ""), HOST: "127.0.0.1" }),
    srv.runtime,
    "start"
  );
  if (path.basename(argv[0]) === "php") argv.splice(1, 0, "-d", `memory_limit=${srv.ramMb}M`);
  argv = wrapLimits(argv, srv.storageMb);
  log(serverId, `$ ${display(argv.slice(argv.indexOf("--") + 1))}`, "runtime", "INFO", depId);

  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const proc: Proc = {
    child,
    startedAt: Date.now(),
    stopping: false,
    exited: false,
    phase: "starting",
    ramLimitMb: srv.ramMb,
  };
  pm.procs.set(serverId, proc);
  child.stdin?.on("error", () => {});
  pipeLines(child.stdout, (l) => log(serverId, l, "runtime", "INFO"));
  pipeLines(child.stderr, (l) => log(serverId, l, "runtime", classify(l)));
  const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
    if (proc.exited) return;
    proc.exited = true;
    void onExit(serverId, proc, code, signal);
  };
  child.on("error", (e) => {
    log(serverId, `Failed to start process: ${e.message}`, "system", "ERROR");
    finalize(127, null);
  });
  child.on("exit", (code, signal) => finalize(code, signal));
  ensureMonitor();
  await db
    .update(servers)
    .set({ containerId: child.pid ? `pid-${child.pid}` : null, lastStartedAt: new Date(), updatedAt: new Date() })
    .where(eq(servers.id, serverId));
  return proc;
}

async function healthWait(serverId: string, proc: Proc, depId: string | null) {
  const until = Date.now() + STARTUP_WINDOW_MS;
  while (Date.now() < until) {
    if (proc.exited) break;
    await sleep(250);
  }
  if (proc.exited) {
    const c = proc.child.exitCode;
    const s = proc.child.signalCode;
    throw new Error(
      `Process exited during startup (${s ? `signal ${s}` : `code ${c}`}). Check the console output above.`
    );
  }
  proc.phase = "running";
  const [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (srv?.port && (await portListening(srv.port))) {
    log(serverId, `Health check passed — HTTP listener on port ${srv.port}. Public URL: /apps/${serverId}/`, "system", "INFO", depId);
  } else {
    log(serverId, `Health check passed — process is alive (no HTTP listener; normal for bots).`, "system", "INFO", depId);
  }
  await db
    .update(servers)
    .set({ status: "RUNNING", updatedAt: new Date() })
    .where(eq(servers.id, serverId));
}

async function onExit(serverId: string, proc: Proc, code: number | null, signal: NodeJS.Signals | null) {
  if (pm.procs.get(serverId) === proc) pm.procs.delete(serverId);
  killGroup(proc.child, "SIGKILL"); // reap leftover children in the group
  const uptime = Math.round((Date.now() - proc.startedAt) / 1000);
  await db
    .update(servers)
    .set({ uptimeSeconds: sql`${servers.uptimeSeconds} + ${uptime}`, containerId: null, updatedAt: new Date() })
    .where(eq(servers.id, serverId))
    .catch(() => {});
  if (proc.stopping) return;
  const desc = signal ? `signal ${signal}` : `code ${code}`;
  if (proc.phase === "starting") {
    log(serverId, `Process exited during startup (${desc}).`, "system", "ERROR");
    return; // the deployment / restart flow reports the failure
  }
  if (code === 0 && !signal) {
    log(serverId, "Process exited normally (code 0).", "system", "INFO");
    await db
      .update(servers)
      .set({ status: "STOPPED", lastStoppedAt: new Date() })
      .where(eq(servers.id, serverId))
      .catch(() => {});
    return;
  }
  log(serverId, `Process crashed (${desc}) after ${uptime}s.`, "system", "ERROR");
  await handleCrash(serverId);
}

async function handleCrash(serverId: string) {
  const now = Date.now();
  const list = (pm.crashes.get(serverId) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
  list.push(now);
  pm.crashes.set(serverId, list);
  const [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!srv || srv.status === "SUSPENDED" || srv.status === "STOPPED" || srv.status === "STOPPING") return;
  await db
    .update(servers)
    .set({ status: "CRASHED", crashCount: sql`${servers.crashCount} + 1`, updatedAt: new Date() })
    .where(eq(servers.id, serverId));
  if (!srv.autoRestart) {
    await notify({ userId: srv.userId, title: "Server crashed", message: `${srv.name} crashed. Auto-restart is disabled.`, type: "error", link: `/dashboard/servers/${serverId}` });
    return;
  }
  if (list.length >= CRASH_LIMIT) {
    log(serverId, `Crash loop detected: ${list.length} crashes in ${CRASH_WINDOW_MS / 1000}s. Auto-restart paused — fix the error, then start the server manually.`, "system", "ERROR");
    await notify({ userId: srv.userId, title: "Crash loop detected", message: `${srv.name} crashed ${list.length} times in 2 minutes. Auto-restart was paused.`, type: "error", link: `/dashboard/servers/${serverId}` });
    return;
  }
  const delay = Math.min(30_000, 2000 * list.length);
  log(serverId, `Auto-restart in ${delay / 1000}s (attempt ${list.length}/${CRASH_LIMIT - 1})`, "system", "WARNING");
  setTimeout(() => void autoRestart(serverId), delay);
}

async function autoRestart(serverId: string) {
  if (pm.procs.has(serverId) || pm.busy.has(serverId)) return;
  const [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!srv || srv.status !== "CRASHED") return; // user stopped / deleted it meanwhile
  pm.busy.add(serverId);
  try {
    await db
      .update(servers)
      .set({ status: "STARTING", restartCount: sql`${servers.restartCount} + 1` })
      .where(eq(servers.id, serverId));
    const proc = await launch(serverId, null);
    await healthWait(serverId, proc, null);
    log(serverId, "Auto-restart succeeded.", "system", "INFO");
  } catch (e) {
    log(serverId, `Auto-restart failed: ${errMsg(e)}`, "system", "ERROR");
    pm.busy.delete(serverId);
    await handleCrash(serverId);
    return;
  }
  pm.busy.delete(serverId);
}

function waitExit(proc: Proc, ms: number): Promise<boolean> {
  return new Promise((res) => {
    if (proc.exited) return res(true);
    const t = setTimeout(() => res(false), ms);
    proc.child.once("exit", () => {
      clearTimeout(t);
      res(true);
    });
  });
}

async function stopProcess(serverId: string, sig: NodeJS.Signals = "SIGTERM", graceMs = 8000): Promise<boolean> {
  const proc = pm.procs.get(serverId);
  if (!proc) return false;
  proc.stopping = true;
  killGroup(proc.child, sig);
  if (!(await waitExit(proc, graceMs))) {
    log(serverId, "Process did not exit in time — sending SIGKILL", "system", "WARNING");
    killGroup(proc.child, "SIGKILL");
    await waitExit(proc, 3000);
  }
  pm.procs.delete(serverId);
  return true;
}

// ───────────────────────── public API ─────────────────────────
export function isProcessRunning(serverId: string): boolean {
  return pm.procs.has(serverId);
}

export function sendInput(serverId: string, line: string): boolean {
  const p = pm.procs.get(serverId);
  if (!p || !p.child.stdin || p.child.stdin.destroyed) return false;
  p.child.stdin.write(line + "\n");
  log(serverId, `> ${line}`, "stdin", "INFO");
  return true;
}

export async function startDeployment(serverId: string): Promise<string> {
  if (pm.busy.has(serverId)) throw new Error("Another operation is already in progress for this server");
  const [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!srv) throw new Error("Server not found");
  if (srv.status === "SUSPENDED") throw new Error("Server is suspended");
  if (process.env.NODE_ENV === "production" && srv.runtime !== "static" && srv.runtime !== "image") {
    // This process manager intentionally uses host child_process for local
    // development only.  Merely setting RUNTIME_WORKER_URL must never make a
    // deployment look isolated when this module is still the executor.
    throw new Error(
      "Dynamic runtime deployments are disabled in the Control Plane. Deploy through a Runtime Worker provider; the local process manager is development-only."
    );
  }
  pm.busy.add(serverId);
  let depId: string;
  try {
    const [dep] = await db
      .insert(deployments)
      .values({ serverId, runtime: srv.runtime, command: srv.startCommand ?? "", status: "QUEUED", stage: "queued", progress: 0 })
      .returning();
    depId = dep.id;
    await db
      .update(servers)
      .set({ locked: true, status: "INSTALLING", updatedAt: new Date() })
      .where(eq(servers.id, serverId));
  } catch (e) {
    pm.busy.delete(serverId);
    throw e;
  }
  void runPipeline(serverId, depId, srv.userId).finally(() => pm.busy.delete(serverId));
  return depId;
}

async function runPipeline(serverId: string, depId: string, userId: string) {
  const stage = async (name: string, progress: number, status?: ServerRow["status"]) => {
    await db.update(deployments).set({ stage: name, progress }).where(eq(deployments.id, depId));
    if (status) await db.update(servers).set({ status, updatedAt: new Date() }).where(eq(servers.id, serverId));
  };
  try {
    await db.update(deployments).set({ status: "RUNNING", startedAt: new Date() }).where(eq(deployments.id, depId));
    log(serverId, "─── Deployment started ───", "system", "INFO", depId);
    if (pm.procs.has(serverId)) {
      log(serverId, "Stopping previous process...", "system", "INFO", depId);
      await stopProcess(serverId);
    }

    await stage("preparing", 10, "INSTALLING");
    const root = await syncWorkspace(serverId, depId);
    let [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!srv) throw new Error("Server disappeared");
    log(serverId, `Runtime: ${srv.runtime} ${srv.runtimeVersion}`, "system", "INFO", depId);

    if (srv.runtime === "static" || srv.runtime === "image") {
      await stage("starting", 80, "STARTING");
      const hasIndex = fs.existsSync(path.join(root, "index.html"));
      const message = srv.runtime === "image"
        ? "Image Hosting is ready; uploads are served through the isolated gateway."
        : (hasIndex ? "index.html found." : "Warning: no index.html at project root.");
      log(serverId, message, "system", srv.runtime === "image" || hasIndex ? "INFO" : "WARNING", depId);
      log(serverId, `Public gateway path: /apps/${serverId}/`, "system", "INFO", depId);
    } else {
      await stage("installing", 30, "INSTALLING");
      await installDeps(srv, root, depId);

      if (srv.buildCommand?.trim()) {
        await stage("building", 60, "BUILDING");
        const env = await buildEnv(srv, true);
        const argv = resolveArgv(parseCommand(srv.buildCommand, { PORT: String(srv.port ?? "") }), srv.runtime, "install");
        const code = await runStep(serverId, depId, argv, root, env, "build", INSTALL_TIMEOUT_MS);
        if (code !== 0) throw new Error(`Build failed (exit code ${code})`);
      } else {
        log(serverId, "No build step configured.", "build", "INFO", depId);
      }

      await telegramPreflight(serverId, depId);

      await stage("starting", 80, "STARTING");
      if (!srv.port || !(await portFree(srv.port))) {
        if (srv.port) log(serverId, `Port ${srv.port} is in use — allocating a new one`, "system", "WARNING", depId);
        const port = await allocatePort(serverId);
        await db.update(servers).set({ port }).where(eq(servers.id, serverId));
        [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
      }
      log(serverId, `Assigned PORT=${srv.port}`, "system", "INFO", depId);
      const proc = await launch(serverId, depId);
      await stage("health_check", 90);
      await healthWait(serverId, proc, depId);
    }

    await db
      .update(servers)
      .set({ status: "RUNNING", locked: false, lastDeployedAt: new Date(), updatedAt: new Date() })
      .where(eq(servers.id, serverId));
    await db
      .update(deployments)
      .set({ status: "COMPLETED", stage: "running", progress: 100, finishedAt: new Date() })
      .where(eq(deployments.id, depId));
    pm.crashes.delete(serverId);
    log(serverId, "─── Deployment completed — server is RUNNING ───", "system", "INFO", depId);
    await notify({ userId, title: "Deployment completed", message: "Your project is now running.", type: "success", link: `/dashboard/servers/${serverId}` });
  } catch (err) {
    const msg = errMsg(err);
    log(serverId, `Deployment failed: ${msg}`, "system", "ERROR", depId);
    await stopProcess(serverId, "SIGKILL", 2000).catch(() => {});
    await db.update(deployments).set({ status: "FAILED", error: msg, finishedAt: new Date() }).where(eq(deployments.id, depId)).catch(() => {});
    await db.update(servers).set({ status: "ERROR", locked: false, updatedAt: new Date() }).where(eq(servers.id, serverId)).catch(() => {});
    await notify({ userId, title: "Deployment failed", message: msg, type: "error", link: `/dashboard/servers/${serverId}` });
  } finally {
    await flushLogs();
  }
}

/**
 * If the project has a Telegram token, verify it against the official Bot API (getMe) before
 * starting. Invalid token → fail fast (prevents a crash loop). Network problem → warning only.
 * Only api.telegram.org is ever contacted by the platform (no SSRF via user-provided URLs).
 */
async function telegramPreflight(serverId: string, depId: string) {
  const rows = await db
    .select({ key: environmentVariables.key, value: environmentVariables.value })
    .from(environmentVariables)
    .where(eq(environmentVariables.serverId, serverId));
  const env = Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  const key = ["BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN"].find((k) => env[k]);
  if (!key) return;
  const token = env[key];
  if (env.TELEGRAM_API_URL && !/^https:\/\/api\.telegram\.org\/?$/i.test(env.TELEGRAM_API_URL)) {
    log(serverId, "Telegram preflight skipped (custom TELEGRAM_API_URL).", "system", "INFO", depId);
    return;
  }
  if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token))
    throw new Error(`${key} does not look like a Telegram bot token (expected 123456789:ABC...).`);
  let data: { ok?: boolean; error_code?: number; description?: string; result?: { username?: string; id?: number } };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    data = await res.json();
  } catch (e) {
    log(serverId, `Telegram API not reachable from this node right now (${errMsg(e)}). Starting anyway — the bot retries automatically.`, "system", "WARNING", depId);
    return;
  }
  if (data.ok) {
    log(serverId, `Telegram API reachable — ${key} is valid for @${data.result?.username} (id ${data.result?.id}).`, "system", "INFO", depId);
  } else if (data.error_code === 401 || data.error_code === 404) {
    throw new Error(`Telegram rejected ${key} (${data.error_code} ${data.description}). Update it in the Environment tab, then deploy again.`);
  } else {
    log(serverId, `Telegram getMe returned ${data.error_code} ${data.description} — starting anyway.`, "system", "WARNING", depId);
  }
}

export async function stopServer(serverId: string, sig: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (pm.busy.has(serverId)) throw new Error("Server is busy with another operation");
  pm.busy.add(serverId);
  try {
    await db.update(servers).set({ status: "STOPPING", locked: true, updatedAt: new Date() }).where(eq(servers.id, serverId));
    log(serverId, sig === "SIGKILL" ? "Killing server (SIGKILL)..." : "Stopping server (SIGTERM)...", "system");
    const had = await stopProcess(serverId, sig, sig === "SIGKILL" ? 2000 : 8000);
    await db
      .update(servers)
      .set({ status: "STOPPED", locked: false, lastStoppedAt: new Date(), containerId: null, updatedAt: new Date() })
      .where(eq(servers.id, serverId));
    pm.crashes.delete(serverId);
    log(serverId, had ? "Server stopped." : "Server stopped (no running process).", "system");
  } finally {
    pm.busy.delete(serverId);
  }
}

export async function killServer(serverId: string) {
  return stopServer(serverId, "SIGKILL");
}

export async function restartServer(serverId: string): Promise<string> {
  if (pm.procs.has(serverId)) await stopServer(serverId);
  await db.update(servers).set({ restartCount: sql`${servers.restartCount} + 1` }).where(eq(servers.id, serverId));
  return startDeployment(serverId);
}

export async function suspendServer(serverId: string) {
  await stopProcess(serverId, "SIGTERM", 5000).catch(() => {});
  await db.update(servers).set({ status: "SUSPENDED", locked: false, containerId: null, updatedAt: new Date() }).where(eq(servers.id, serverId));
  log(serverId, "Server suspended by administrator.", "system", "WARNING");
}

export async function resumeServer(serverId: string) {
  await db.update(servers).set({ status: "STOPPED", updatedAt: new Date() }).where(eq(servers.id, serverId));
  log(serverId, "Server resumed by administrator. You can start it now.", "system");
}

/** Stop the process, delete the workspace and release the port. Call before deleting the DB row. */
export async function destroyServer(serverId: string) {
  await stopProcess(serverId, "SIGKILL", 2000).catch(() => {});
  pm.crashes.delete(serverId);
  pm.secrets.delete(serverId);
  pm.diskCache.delete(serverId);
  await fsp.rm(workspaceDir(serverId), { recursive: true, force: true }).catch(() => {});
  await releasePort(serverId).catch(() => {});
}

// ───────────────────────── monitoring ─────────────────────────
type PInfo = { pid: number; ppid: number; ticks: number; rssPages: number };

async function readProcTable(): Promise<Map<number, PInfo>> {
  const out = new Map<number, PInfo>();
  let entries: string[] = [];
  try {
    entries = await fsp.readdir("/proc");
  } catch {
    return out;
  }
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        try {
          const s = await fsp.readFile(`/proc/${e}/stat`, "utf8");
          const r = s.slice(s.lastIndexOf(")") + 2).split(" ");
          out.set(+e, { pid: +e, ppid: +r[1], ticks: +r[11] + +r[12], rssPages: +r[21] });
        } catch {}
      })
  );
  return out;
}

function treeOf(rootPid: number, table: Map<number, PInfo>): PInfo[] {
  const children = new Map<number, number[]>();
  for (const p of table.values()) {
    const arr = children.get(p.ppid) ?? [];
    arr.push(p.pid);
    children.set(p.ppid, arr);
  }
  const out: PInfo[] = [];
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = table.get(pid);
    if (info) out.push(info);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length && count < 200_000) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      count++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(p)).size;
        } catch {}
      }
    }
  }
  return total;
}

async function diskUsageMb(serverId: string): Promise<number> {
  const c = pm.diskCache.get(serverId);
  if (c && Date.now() - c.at < 120_000) return c.mb;
  const mb = Math.ceil((await dirSizeBytes(workspaceDir(serverId))) / 1048576);
  pm.diskCache.set(serverId, { mb, at: Date.now() });
  return mb;
}

function ensureMonitor() {
  if (pm.monitorTimer) return;
  pm.monitorTimer = setInterval(() => void monitorTick(), MONITOR_INTERVAL_MS);
  pm.monitorTimer.unref?.();
}

async function monitorTick() {
  try {
    if (pm.procs.size === 0) {
      if (pm.monitorTimer) clearInterval(pm.monitorTimer);
      pm.monitorTimer = null;
      return;
    }
    const table = await readProcTable();
    const rows: (typeof serverMetrics.$inferInsert)[] = [];
    for (const [serverId, proc] of pm.procs) {
      const pid = proc.child.pid;
      if (!pid || proc.exited) continue;
      const tree = treeOf(pid, table);
      const ticks = tree.reduce((a, p) => a + p.ticks, 0);
      const rssMb = Math.round((tree.reduce((a, p) => a + p.rssPages, 0) * PAGE_SIZE) / 1048576);
      const now = Date.now();
      let cpu = 0;
      if (proc.prevCpu) {
        const dt = (now - proc.prevCpu.at) / 1000;
        cpu = Math.max(0, Math.round(((ticks - proc.prevCpu.ticks) / CLK_TCK / dt) * 100));
      }
      proc.prevCpu = { ticks, at: now };
      rows.push({ serverId, cpuPercent: cpu, ramMb: rssMb, diskMb: await diskUsageMb(serverId) });
      if (rssMb > proc.ramLimitMb) {
        log(serverId, `Memory limit exceeded: ${rssMb} MB > ${proc.ramLimitMb} MB. Process killed (OOM).`, "system", "ERROR");
        killGroup(proc.child, "SIGKILL");
      }
    }
    if (rows.length) await db.insert(serverMetrics).values(rows).catch(() => {});
    if (Date.now() - pm.lastTrim > 10 * 60_000) {
      pm.lastTrim = Date.now();
      await trimData();
    }
  } catch (e) {
    console.error("[pm] monitor error", e);
  }
}

/** Retention: metrics 24h, logs 14 days and max N rows per server. */
export async function trimData() {
  await db.execute(sql`DELETE FROM server_metrics WHERE created_at < NOW() - INTERVAL '24 hours'`).catch(() => {});
  await db.execute(sql`DELETE FROM server_logs WHERE created_at < NOW() - INTERVAL '14 days'`).catch(() => {});
  await db
    .execute(
      sql`DELETE FROM server_logs l USING (
            SELECT id, row_number() OVER (PARTITION BY server_id ORDER BY id DESC) AS rn FROM server_logs
          ) x WHERE l.id = x.id AND x.rn > ${LOG_KEEP_PER_SERVER}`
    )
    .catch(() => {});
}

/** On platform boot: kill orphan processes from a previous run and resume servers that were running. */
export async function recoverOnBoot() {
  if (pm.recovered) return;
  pm.recovered = true;
  const rows = await db
    .select()
    .from(servers)
    .where(inArray(servers.status, ["RUNNING", "STARTING", "INSTALLING", "BUILDING", "STOPPING", "CRASHED"]));
  await db.update(servers).set({ locked: false }).where(eq(servers.locked, true));
  for (const s of rows) {
    if (pm.procs.has(s.id)) continue;
    // Kill an orphan from a previous platform process, but only if it really lives in this workspace.
    const pid = s.containerId?.startsWith("pid-") ? Number(s.containerId.slice(4)) : 0;
    if (pid > 1) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd.startsWith(workspaceDir(s.id))) process.kill(-pid, "SIGKILL");
      } catch {}
    }
    if (s.status === "RUNNING" && (s.autoRestart || s.runtime === "static")) {
      log(s.id, "Platform restarted — resuming server.", "system", "WARNING");
      await startDeployment(s.id).catch((e) => log(s.id, `Resume failed: ${errMsg(e)}`, "system", "ERROR"));
    } else {
      await db.update(servers).set({ status: "STOPPED", containerId: null }).where(eq(servers.id, s.id));
      log(s.id, "Platform restarted — server marked as stopped.", "system", "WARNING");
    }
  }
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

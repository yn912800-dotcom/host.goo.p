import { db, pool } from "@/db";
import { plans, runtimes, settings, users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "./auth";
import { binaryVersion, ensurePhpRuntime, findBinary, recoverOnBoot } from "./deploy";

const RUNTIME_BINARIES: Record<string, { bin: string; label: string; args?: string[] }> = {
  node: { bin: "node", label: "Node.js" },
  python: { bin: "python3", label: "Python" },
  php: { bin: "php", label: "PHP" },
  go: { bin: "go", label: "Go", args: ["version"] },
  ruby: { bin: "ruby", label: "Ruby" },
  java: { bin: "java", label: "Java" },
  rust: { bin: "cargo", label: "Rust" },
  deno: { bin: "deno", label: "Deno" },
  shell: { bin: "bash", label: "Shell" },
};

/**
 * Mark runtimes as installed only if the binary really exists on this node and the version
 * matches; add a row for the actually installed version if it's missing.
 */
async function syncRuntimeAvailability() {
  const rows = await db.select().from(runtimes);
  for (const [type, info] of Object.entries(RUNTIME_BINARIES)) {
    const present = !!findBinary(info.bin);
    const full = present ? binaryVersion(info.bin, info.args) : null;
    // node/python/php → major.minor ("22", "3.11", "8.2") granularity
    const short = full ? (type === "node" ? full.split(".")[0] : full.split(".").slice(0, 2).join(".")) : null;
    const typeRows = rows.filter((r) => r.type === type);
    for (const r of typeRows) {
      const installed =
        present && (!short || ["latest", "stable"].includes(r.version) || short === r.version || short.startsWith(r.version + "."));
      if (r.isInstalled !== installed) {
        await db.update(runtimes).set({ isInstalled: installed }).where(eq(runtimes.id, r.id));
      }
    }
    const hasMatch = typeRows.some(
      (r) => short && (short === r.version || short.startsWith(r.version + ".") || ["latest", "stable"].includes(r.version))
    );
    if (present && short && !hasMatch && type !== "shell") {
      await db.insert(runtimes).values({
        type: type as (typeof runtimes.$inferInsert)["type"],
        version: short,
        displayName: `${info.label} ${short}`,
        isInstalled: true,
        isEnabled: ["node", "python", "php"].includes(type),
        isDefault: typeRows.length === 0,
      });
    }
  }
}

let bootstrapped = false;
let bootstrapping: Promise<void> | null = null;

export async function ensureBootstrap() {
  if (bootstrapped) return;
  if (bootstrapping) return bootstrapping;
  bootstrapping = (async () => {
    try {
      // Apply pending migrations on every boot. Drizzle tracks completed
      // migrations and this preserves existing users/projects while allowing
      // safe additive schema upgrades.
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      const path = await import("node:path");
      // Hold a session-level lock on a dedicated PostgreSQL connection so
      // concurrent application replicas cannot run the same migrations.
      const lockClient = await pool.connect();
      try {
        await lockClient.query("SELECT pg_advisory_lock($1)", [726218431]);
        await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      } finally {
        try {
          await lockClient.query("SELECT pg_advisory_unlock($1)", [726218431]);
          lockClient.release();
        } catch (unlockError) {
          lockClient.release(unlockError instanceof Error ? unlockError : new Error(String(unlockError)));
          throw unlockError;
        }
      }

      // Settings defaults
      await db
        .insert(settings)
        .values({ key: "platform", value: defaultSettings })
        .onConflictDoNothing();

      // Plans
      const planCount = await db.execute<{ c: string }>(
        sql`SELECT COUNT(*)::text as c FROM plans`
      );
      if (Number(planCount.rows[0]?.c ?? 0) === 0) {
        await db.insert(plans).values(defaultPlans);
      }

      // Runtimes
      const rtCount = await db.execute<{ c: string }>(
        sql`SELECT COUNT(*)::text as c FROM runtimes`
      );
      if (Number(rtCount.rows[0]?.c ?? 0) === 0) {
        await db.insert(runtimes).values(defaultRuntimes);
      }

      // Ensure the configured super admin (from env) exists.
      // Credentials are never hardcoded in source — set ADMIN_EMAIL / ADMIN_PASSWORD in .env
      const envEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
      const envPassword = process.env.ADMIN_PASSWORD;
      const [existingAdmin] = envEmail
        ? await db.select({ id: users.id }).from(users).where(eq(users.email, envEmail)).limit(1)
        : [];
      if (envEmail && envPassword && !existingAdmin) {
        const email = envEmail;
        const password = envPassword;
        const hash = await hashPassword(password);
        // Find default plan id
        const [defaultPlan] = await db
          .select()
          .from(plans)
          .where(eq(plans.isDefault, true))
          .limit(1);
        await db
          .insert(users)
          .values({
            email,
            name: "Platform Admin",
            passwordHash: hash,
            role: "SUPER_ADMIN",
            emailVerified: true,
            planId: defaultPlan?.id,
          })
          .onConflictDoNothing();
        console.log(`[bootstrap] Seeded super admin ${email}`);
      }

      await syncRuntimeAvailability();
      if (!findBinary("php")) {
        void ensurePhpRuntime()
          .then((ok) => (ok ? syncRuntimeAvailability() : undefined))
          .catch((error) => console.error("[bootstrap] background PHP setup failed", error));
      }
      bootstrapped = true;
      // Resume servers that were running before the platform restarted (background).
      void recoverOnBoot().catch((e) => console.error("[bootstrap] recover failed", e));
    } catch (e) {
      console.error("[bootstrap] failed", e);
      throw e;
    } finally {
      bootstrapping = null;
    }
  })();
  return bootstrapping;
}

const defaultPlans = [
  {
    name: "Free",
    slug: "free",
    description: "Perfect for trying out the platform.",
    priceCents: 0,
    storageMb: 500,
    ramMb: 256,
    cpuMillis: 250,
    maxServers: 1,
    maxBackups: 1,
    maxDomains: 1,
    bandwidthGb: 5,
    isDefault: true,
    sortOrder: 1,
    features: [
      "1 project",
      "500 MB storage",
      "256 MB RAM",
      "Shared CPU",
      "Community support",
    ],
  },
  {
    name: "Basic",
    slug: "basic",
    description: "For small side-projects and bots.",
    priceCents: 500,
    storageMb: 2048,
    ramMb: 512,
    cpuMillis: 500,
    maxServers: 3,
    maxBackups: 3,
    maxDomains: 2,
    bandwidthGb: 50,
    sortOrder: 2,
    features: ["3 projects", "2 GB storage", "512 MB RAM", "0.5 vCPU", "Daily backups"],
  },
  {
    name: "Pro",
    slug: "pro",
    description: "For production applications.",
    priceCents: 1500,
    storageMb: 10240,
    ramMb: 2048,
    cpuMillis: 1000,
    maxServers: 10,
    maxBackups: 10,
    maxDomains: 5,
    bandwidthGb: 200,
    sortOrder: 3,
    features: [
      "10 projects",
      "10 GB storage",
      "2 GB RAM",
      "1 vCPU",
      "Priority support",
      "Custom domains",
    ],
  },
  {
    name: "Business",
    slug: "business",
    description: "For agencies and teams.",
    priceCents: 4900,
    storageMb: 25600,
    ramMb: 4096,
    cpuMillis: 2000,
    maxServers: 25,
    maxBackups: 25,
    maxDomains: 20,
    bandwidthGb: 1000,
    sortOrder: 4,
    features: [
      "25 projects",
      "25 GB storage",
      "4 GB RAM",
      "2 vCPU",
      "SSL on all domains",
      "SLA 99.9%",
    ],
  },
];

const defaultRuntimes = [
  {
    type: "node" as const,
    version: "20",
    displayName: "Node.js 20 LTS",
    installCommand: "npm install",
    defaultStartCommand: "npm start",
    isDefault: true,
  },
  {
    type: "node" as const,
    version: "22",
    displayName: "Node.js 22",
    installCommand: "npm install",
    defaultStartCommand: "npm start",
  },
  {
    type: "python" as const,
    version: "3.11",
    displayName: "Python 3.11",
    installCommand: "pip install -r requirements.txt",
    defaultStartCommand: "python main.py",
    isDefault: true,
  },
  {
    type: "python" as const,
    version: "3.12",
    displayName: "Python 3.12",
    installCommand: "pip install -r requirements.txt",
    defaultStartCommand: "python main.py",
  },
  {
    type: "php" as const,
    version: "8.2",
    displayName: "PHP 8.2",
    installCommand: "composer install",
    defaultStartCommand: "php -S 0.0.0.0:$PORT -t .",
    isDefault: true,
  },
  {
    type: "static" as const,
    version: "latest",
    displayName: "Static HTML",
    defaultStartCommand: "static-server",
    isDefault: true,
  },
  {
    type: "image" as const,
    version: "1",
    displayName: "Image Hosting",
    defaultStartCommand: null,
    isDefault: true,
  },
  {
    type: "go" as const,
    version: "1.22",
    displayName: "Go 1.22",
    defaultStartCommand: "go run .",
    isDefault: true,
  },
];

const defaultSettings = {
  platformName: "•-تــيــ۾ إڪـXـس-•",
  description: "Deploy any project, in seconds.",
  registrationEnabled: true,
  googleLoginEnabled: false,
  maintenanceMode: false,
  defaultPlanSlug: "free",
  logRetentionDays: 14,
  metricsRetentionDays: 7,
  maxUploadMb: 50,
};

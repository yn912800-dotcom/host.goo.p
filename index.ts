import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

// Next.js imports route modules while producing the standalone bundle.  A build
// must not open a database connection, but a running application must fail
// clearly instead of silently using a fake database.  The placeholder is only
// used during `next build`; every real query will still fail fast if the runtime
// was started without DATABASE_URL.
const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";
const connectionString = databaseUrl ?? (isNextBuild
  ? "postgresql://build:build@127.0.0.1:5432/build"
  : undefined);

if (!connectionString) {
  throw new Error("DATABASE_URL is required at runtime");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString,
    max: Number.isInteger(Number(process.env.PGPOOL_MAX)) && Number(process.env.PGPOOL_MAX) >= 2 && Number(process.env.PGPOOL_MAX) <= 50
      ? Number(process.env.PGPOOL_MAX)
      : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);

import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "ph_session";
export const SESSION_MAX_AGE_DAYS = 30;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string } = {}
): Promise<string> {
  const token = generateToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  );
  await db.insert(sessions).values({
    userId,
    tokenHash,
    ip: meta.ip,
    userAgent: meta.userAgent,
    expiresAt,
  });
  return token;
}

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: "USER" | "ADMIN" | "SUPER_ADMIN";
  avatarUrl: string | null;
  planId: number | null;
  status: string;
  locale: string;
  theme: string;
};

export async function getUserFromToken(
  token: string
): Promise<AuthUser | null> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      avatarUrl: users.avatarUrl,
      planId: users.planId,
      status: users.status,
      locale: users.locale,
      theme: users.theme,
      sessionId: sessions.id,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date()))
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Update last active (fire-and-forget)
  db.update(sessions)
    .set({ lastActiveAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch((error) => console.error("[auth] failed to update session activity", error));
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatarUrl: row.avatarUrl,
    planId: row.planId,
    status: row.status,
    locale: row.locale,
    theme: row.theme,
  };
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getUserFromToken(token);
}

export async function requireUser(): Promise<AuthUser> {
  const u = await getCurrentUser();
  if (!u) throw new HttpError(401, "Unauthorized");
  if (u.status !== "ACTIVE")
    throw new HttpError(403, `Account is ${u.status}`);
  return u;
}

export async function requireAdmin(): Promise<AuthUser> {
  const u = await requireUser();
  if (u.role !== "ADMIN" && u.role !== "SUPER_ADMIN")
    throw new HttpError(403, "Admin privileges required");
  return u;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errorResponse(err: unknown) {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error("API error:", err);
  return Response.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function destroySessionByToken(token: string) {
  const tokenHash = hashToken(token);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

import { db } from "@/db";
import { servers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { HttpError, type AuthUser } from "./auth";

export async function getServerForUser(serverId: string, user: AuthUser) {
  // Admins can access any server
  const [row] =
    user.role === "ADMIN" || user.role === "SUPER_ADMIN"
      ? await db.select().from(servers).where(eq(servers.id, serverId)).limit(1)
      : await db
          .select()
          .from(servers)
          .where(and(eq(servers.id, serverId), eq(servers.userId, user.id)))
          .limit(1);
  if (!row) throw new HttpError(404, "Server not found");
  return row;
}

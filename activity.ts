import { db } from "@/db";
import { activityLogs, auditLogs, notifications } from "@/db/schema";

export async function logActivity(opts: {
  userId?: string | null;
  serverId?: string | null;
  action: string;
  detail?: string;
  ip?: string;
}) {
  try {
    await db.insert(activityLogs).values({
      userId: opts.userId ?? null,
      serverId: opts.serverId ?? null,
      action: opts.action,
      detail: opts.detail,
      ip: opts.ip,
    });
  } catch (e) {
    console.error("activity log failed", e);
  }
}

export async function logAudit(opts: {
  adminId: string;
  targetType: string;
  targetId?: string;
  action: string;
  detail?: Record<string, unknown>;
}) {
  try {
    await db.insert(auditLogs).values({
      adminId: opts.adminId,
      targetType: opts.targetType,
      targetId: opts.targetId,
      action: opts.action,
      detail: opts.detail as unknown as object,
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}

export async function notify(opts: {
  userId: string;
  title: string;
  message: string;
  type?: string;
  link?: string;
}) {
  try {
    await db.insert(notifications).values({
      userId: opts.userId,
      title: opts.title,
      message: opts.message,
      type: opts.type ?? "info",
      link: opts.link,
    });
  } catch (e) {
    console.error("notify failed", e);
  }
}

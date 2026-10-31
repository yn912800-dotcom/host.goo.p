import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

// ============ Enums ============
export const roleEnum = pgEnum("user_role", ["USER", "ADMIN", "SUPER_ADMIN"]);
export const serverStatusEnum = pgEnum("server_status", [
  "CREATED",
  "INSTALLING",
  "BUILDING",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "CRASHED",
  "ERROR",
  "SUSPENDED",
]);
export const deploymentStatusEnum = pgEnum("deployment_status", [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export const runtimeEnum = pgEnum("runtime_type", [
  "python",
  "node",
  "php",
  "static",
  "image",
  "java",
  "go",
  "ruby",
  "rust",
  "deno",
  "shell",
]);
export const logLevelEnum = pgEnum("log_level", [
  "INFO",
  "WARNING",
  "ERROR",
  "DEBUG",
  "SECURITY",
  "AUDIT",
]);

// ============ Users ============
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    name: varchar("name", { length: 120 }).notNull(),
    avatarUrl: text("avatar_url"),
    role: roleEnum("role").default("USER").notNull(),
    planId: integer("plan_id"),
    status: varchar("status", { length: 32 }).default("ACTIVE").notNull(), // ACTIVE, SUSPENDED, BANNED
    googleId: varchar("google_id", { length: 128 }),
    locale: varchar("locale", { length: 8 }).default("ar").notNull(),
    theme: varchar("theme", { length: 16 }).default("dark").notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    index("users_role_idx").on(t.role),
  ]
);

// ============ Sessions ============
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    userAgent: text("user_agent"),
    ip: varchar("ip", { length: 64 }),
    lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("sessions_token_idx").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ]
);

// ============ Plans ============
export const plans = pgTable("plans", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 64 }).notNull(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  description: text("description"),
  priceCents: integer("price_cents").default(0).notNull(),
  currency: varchar("currency", { length: 8 }).default("USD").notNull(),
  storageMb: integer("storage_mb").notNull(),
  ramMb: integer("ram_mb").notNull(),
  cpuMillis: integer("cpu_millis").notNull(), // 1000 = 1 CPU
  maxServers: integer("max_servers").notNull(),
  maxBackups: integer("max_backups").default(3).notNull(),
  maxDomains: integer("max_domains").default(1).notNull(),
  bandwidthGb: integer("bandwidth_gb").default(10).notNull(),
  features: jsonb("features").$type<string[]>().default([]).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============ Runtimes ============
export const runtimes = pgTable("runtimes", {
  id: serial("id").primaryKey(),
  type: runtimeEnum("type").notNull(),
  version: varchar("version", { length: 32 }).notNull(),
  displayName: varchar("display_name", { length: 64 }).notNull(),
  isInstalled: boolean("is_installed").default(true).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  installCommand: text("install_command"),
  defaultStartCommand: text("default_start_command"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============ Servers (Projects) ============
export const servers = pgTable(
  "servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 140 }).notNull(),
    description: text("description"),
    runtime: runtimeEnum("runtime").notNull(),
    runtimeVersion: varchar("runtime_version", { length: 32 }).notNull(),
    entryPoint: varchar("entry_point", { length: 255 }),
    startCommand: text("start_command"),
    installCommand: text("install_command"),
    buildCommand: text("build_command"),
    status: serverStatusEnum("status").default("CREATED").notNull(),
    port: integer("port"),
    containerId: varchar("container_id", { length: 128 }),
    cpuMillis: integer("cpu_millis").default(250).notNull(),
    ramMb: integer("ram_mb").default(256).notNull(),
    storageMb: integer("storage_mb").default(500).notNull(),
    autoRestart: boolean("auto_restart").default(true).notNull(),
    restartCount: integer("restart_count").default(0).notNull(),
    crashCount: integer("crash_count").default(0).notNull(),
    lastStartedAt: timestamp("last_started_at"),
    lastStoppedAt: timestamp("last_stopped_at"),
    lastDeployedAt: timestamp("last_deployed_at"),
    uptimeSeconds: bigint("uptime_seconds", { mode: "number" })
      .default(0)
      .notNull(),
    locked: boolean("locked").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("servers_user_slug_idx").on(t.userId, t.slug),
    index("servers_user_idx").on(t.userId),
    index("servers_status_idx").on(t.status),
  ]
);

// ============ Files ============
export const files = pgTable(
  "files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    path: text("path").notNull(), // normalized relative path, e.g. "src/index.js"
    name: varchar("name", { length: 255 }).notNull(),
    isDirectory: boolean("is_directory").default(false).notNull(),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    mimeType: varchar("mime_type", { length: 128 }),
    content: text("content"), // text content; null for binary/dirs
    binaryContent: text("binary_content"), // base64 for small binaries
    isBinary: boolean("is_binary").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("files_server_path_idx").on(t.serverId, t.path),
    index("files_server_idx").on(t.serverId),
  ]
);

// ============ Deployments ============
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    status: deploymentStatusEnum("status").default("QUEUED").notNull(),
    runtime: runtimeEnum("runtime").notNull(),
    command: text("command"),
    stage: varchar("stage", { length: 64 }).default("queued").notNull(),
    progress: integer("progress").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("deployments_server_idx").on(t.serverId)]
);

// ============ Server Logs ============
export const serverLogs = pgTable(
  "server_logs",
  {
    id: serial("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id"),
    level: logLevelEnum("level").default("INFO").notNull(),
    source: varchar("source", { length: 32 }).default("runtime").notNull(), // runtime, build, install, system
    message: text("message").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("server_logs_server_idx").on(t.serverId),
    index("server_logs_created_idx").on(t.createdAt),
  ]
);

// ============ Server Metrics ============
export const serverMetrics = pgTable(
  "server_metrics",
  {
    id: serial("id").primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    cpuPercent: integer("cpu_percent").notNull(),
    ramMb: integer("ram_mb").notNull(),
    diskMb: integer("disk_mb").notNull(),
    networkRxKb: integer("network_rx_kb").default(0).notNull(),
    networkTxKb: integer("network_tx_kb").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("server_metrics_server_idx").on(t.serverId),
    index("server_metrics_created_idx").on(t.createdAt),
  ]
);

// ============ Env Variables ============
export const environmentVariables = pgTable(
  "environment_variables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 128 }).notNull(),
    value: text("value").notNull(),
    isSecret: boolean("is_secret").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("env_server_key_idx").on(t.serverId, t.key)]
);

// ============ Backups ============
export const backups = pgTable(
  "backups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull(),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    fileCount: integer("file_count").default(0).notNull(),
    status: varchar("status", { length: 32 }).default("READY").notNull(),
    snapshot: jsonb("snapshot").notNull(), // {files: [{path, content, isBinary, binaryContent}]}
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("backups_server_idx").on(t.serverId)]
);

// ============ Domains ============
export const domains = pgTable(
  "domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    hostname: varchar("hostname", { length: 253 }).notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    sslEnabled: boolean("ssl_enabled").default(false).notNull(),
    sslStatus: varchar("ssl_status", { length: 32 }).default("none").notNull(),
    verified: boolean("verified").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("domains_hostname_idx").on(t.hostname)]
);

// ============ Notifications ============
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    message: text("message").notNull(),
    type: varchar("type", { length: 32 }).default("info").notNull(),
    read: boolean("read").default(false).notNull(),
    link: text("link"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("notif_user_idx").on(t.userId)]
);

// ============ Activity Logs ============
export const activityLogs = pgTable(
  "activity_logs",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    serverId: uuid("server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 64 }).notNull(),
    detail: text("detail"),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("activity_user_idx").on(t.userId),
    index("activity_created_idx").on(t.createdAt),
  ]
);

// ============ Audit Logs (admin actions) ============
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  adminId: uuid("admin_id").references(() => users.id, { onDelete: "set null" }),
  targetType: varchar("target_type", { length: 64 }).notNull(),
  targetId: varchar("target_id", { length: 128 }),
  action: varchar("action", { length: 64 }).notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============ API Keys ============
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    prefix: varchar("prefix", { length: 16 }).notNull(),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.tokenHash)]
);

// ============ Settings (singleton kv) ============
export const settings = pgTable("settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============ Ports ============
export const ports = pgTable(
  "ports",
  {
    port: integer("port").primaryKey(),
    serverId: uuid("server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    allocatedAt: timestamp("allocated_at").defaultNow().notNull(),
  },
  (t) => [index("ports_server_idx").on(t.serverId)]
);

// ============ Jobs ============
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).default("QUEUED").notNull(),
    serverId: uuid("server_id").references(() => servers.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    payload: jsonb("payload"),
    progress: integer("progress").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("jobs_status_idx").on(t.status)]
);

// ============ Broadcasts (admin announcements) ============
export const broadcasts = pgTable("broadcasts", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: varchar("title", { length: 200 }).notNull(),
  message: text("message").notNull(),
  level: varchar("level", { length: 16 }).default("info").notNull(),
  audience: varchar("audience", { length: 32 }).default("all").notNull(),
  active: boolean("active").default(true).notNull(),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============ Password Resets / Email Verifications ============
export const passwordResets = pgTable("password_resets", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

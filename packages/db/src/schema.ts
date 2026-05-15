import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  int,
  json,
  mysqlEnum,
  index,
} from 'drizzle-orm/mysql-core';

// ---------- channels ----------
export const channels = mysqlTable('channels', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  acronym: varchar('acronym', { length: 16 }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  inviteLink: varchar('invite_link', { length: 512 }),
  whatsappId: varchar('whatsapp_id', { length: 128 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  tenantNameIdx: index('tenant_name_idx').on(t.tenantId, t.name),
}));

// ---------- jobs ----------
// Un job = una publicación programada (con o sin media, con o sin caption)
export const jobs = mysqlTable('jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  channelId: varchar('channel_id', { length: 36 }).notNull(),
  channelName: varchar('channel_name', { length: 255 }).notNull(),

  text: text('text'),                                  // mensaje de texto (o caption si hay media)
  media: json('media').$type<JobMedia[]>(),            // array de adjuntos (ver tipo abajo)

  scheduledAt: timestamp('scheduled_at').notNull(),
  status: mysqlEnum('status', [
    'pending', 'resolving', 'ready', 'publishing', 'sent', 'failed', 'cancelled',
  ]).notNull().default('pending'),

  attemptCount: int('attempt_count').notNull().default(0),
  maxAttempts: int('max_attempts').notNull().default(3),

  lastError: text('last_error'),
  durationMs: int('duration_ms'),
  sentAt: timestamp('sent_at'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  statusSchedIdx: index('status_sched_idx').on(t.status, t.scheduledAt),
  tenantStatusIdx: index('tenant_status_idx').on(t.tenantId, t.status),
}));

// Tipo del campo JSON `media`
export type JobMedia = {
  source: string;          // "s3://bucket/key" | "https://..." | "file:///path" | "/abs/path"
  localPath?: string;      // rellenado por resolve-worker tras descarga
  mime?: string;           // detectado por resolve-worker
  sizeBytes?: number;
};

// ---------- audit_log ----------
export const auditLog = mysqlTable('audit_log', {
  id: int('id').primaryKey().autoincrement(),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  actor: varchar('actor', { length: 64 }).notNull(),      // 'user' | 'system' | 'worker'
  action: varchar('action', { length: 128 }).notNull(),
  targetId: varchar('target_id', { length: 64 }),         // id de job/channel/...
  meta: json('meta'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  tenantCreatedIdx: index('tenant_created_idx').on(t.tenantId, t.createdAt),
}));

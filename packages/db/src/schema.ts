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
  // Orden estable de entrada para lotes. Permite publicar a igual scheduledAt
  // respetando orden de encolado aunque resolve procese media en paralelo.
  enqueueSeq: int('enqueue_seq').notNull().default(0),
  status: mysqlEnum('status', [
    'pending', 'resolving', 'ready', 'publishing', 'sent', 'failed', 'cancelled',
  ]).notNull().default('pending'),

  attemptCount: int('attempt_count').notNull().default(0),
  maxAttempts: int('max_attempts').notNull().default(3),

  lastError: text('last_error'),
  // Ruta del dump de debug (screenshot + HTML) que genera el core al fallar
  // una publicación. Solo la ruta; el archivo vive en el host del worker.
  debugDumpPath: text('debug_dump_path'),
  // Metadata de verificación post-envío (auditoría). Ver PublishVerificationMeta
  // en @tamaya/shared-types.
  verificationMeta: json('verification_meta'),
  durationMs: int('duration_ms'),
  sentAt: timestamp('sent_at'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  // Soft-delete: cuando no es null, el job se considera eliminado y queda
  // excluido de listados, detalle y métricas. Nunca se borra la fila.
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  statusSchedIdx: index('status_sched_idx').on(t.status, t.scheduledAt),
  tenantStatusIdx: index('tenant_status_idx').on(t.tenantId, t.status),
  tenantSchedSeqIdx: index('tenant_sched_seq_idx').on(t.tenantId, t.scheduledAt, t.enqueueSeq),
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

// ---------- app_settings ----------
// Almacén clave/valor para configuración persistida de la aplicación.
// Diseñado para crecer sin cambios de schema. Usos previstos:
//   - 'security.apiTokenHash'  → hash del API token (nunca el token plano)
//   - flags futuros            → p.ej. 'whatsapp.headless'
//   - configuración futura de WhatsApp / overrides de selectores / embeds
// El valor se guarda como texto (JSON serializado cuando haga falta estructura).
export const appSettings = mysqlTable('app_settings', {
  key: varchar('key', { length: 191 }).primaryKey(),
  value: text('value'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export type AppSetting = typeof appSettings.$inferSelect;

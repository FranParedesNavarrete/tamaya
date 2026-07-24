import { z } from 'zod';

export const MediaMimeHintSchema = z.enum([
  // Imágenes soportadas por WhatsApp Channels en el flujo actual.
  'jpg', 'jpeg', 'png', 'gif', 'webp',
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  // Vídeos recomendados/soportados. MP4 es el más fiable.
  'mp4', 'mov', 'webm',
  'video/mp4', 'video/quicktime', 'video/webm',
]);

export const MediaSourceSchema = z.object({
  source: z.string().min(1),
  /**
   * Pista opcional para URLs sin extensión o Content-Type fiable, p.ej. S3
   * presigned: "png", "jpg", "mp4" o MIME completo "image/png".
   */
  mimeType: MediaMimeHintSchema.optional(),
  /** Nombre original opcional; Tamaya puede usar su extensión como fallback. */
  originalName: z.string().optional(),
});

/**
 * Formato cómodo para integraciones humanas/Laravel/n8n: "YYYY-MM-DD HH:mm:ss".
 * La API lo interpreta como hora local Europe/Madrid salvo que en el futuro se
 * envíe un timezone explícito. `scheduledAt` ISO se mantiene por compatibilidad.
 */
export const LocalDateTimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  'Expected format YYYY-MM-DD HH:mm:ss',
);
export const PublishNowSchema = z.literal('now');

export const CreateJobSchema = z.object({
  channelId: z.string().uuid(),
  text: z.string().optional(),
  media: z.array(MediaSourceSchema).default([]),
  /** ISO 8601 con timezone, ej. 2026-07-22T11:20:00.000Z o 2026-07-22T13:20:00+02:00. También acepta "now". */
  scheduledAt: z.union([z.string().datetime({ offset: true }), LocalDateTimeSchema, PublishNowSchema]).optional(),
  /** Alias recomendado para integraciones: hora local Madrid, ej. 2026-05-13 14:57:50. También acepta "now". */
  datetime: z.union([LocalDateTimeSchema, PublishNowSchema]).optional(),
  /** Alternativa explícita para publicar inmediatamente. */
  publishNow: z.boolean().optional(),
}).refine(
  (d) => (d.text && d.text.length > 0) || d.media.length > 0,
  { message: 'At least one of text or media is required' },
).refine(
  (d) => Boolean(d.scheduledAt || d.datetime || d.publishNow),
  { message: 'One of scheduledAt, datetime or publishNow is required' },
);

export const JobStatusSchema = z.enum([
  'pending', 'resolving', 'ready', 'publishing', 'sent', 'failed', 'cancelled',
]);

const TriStateSchema = z.union([z.boolean(), z.literal('unknown')]);

/**
 * Metadata de verificación de publicación (auditoría). La produce el core tras
 * pulsar Send y la persiste worker-publish en `jobs.verificationMeta`.
 *
 * `result`:
 *   - 'verified'              → hay evidencia de que el contenido se publicó.
 *   - 'verification_failed'   → evidencia de que NO se publicó (retryable).
 *   - 'ambiguous_after_send'  → se pulsó Send pero no se pudo confirmar el
 *                               contenido; NO se reintenta para evitar duplicados.
 */
export const PublishVerificationMetaSchema = z.object({
  expected: z.object({
    hasText: z.boolean(),
    textLength: z.number().int(),
    hasMedia: z.boolean(),
    mediaKind: z.enum(['image', 'video', 'audio', 'document']).optional(),
    mediaMime: z.string().optional(),
    mediaSha256: z.string().optional(),
  }),
  observed: z.object({
    previewClosed: z.boolean(),
    sendClicked: z.boolean(),
    indicatorAppeared: z.boolean(),
    threadItemAppeared: z.boolean(),
    textMatched: TriStateSchema,
    mediaDetected: TriStateSchema,
    uploadPendingCleared: TriStateSchema,
  }),
  result: z.enum(['verified', 'verification_failed', 'ambiguous_after_send']),
  reason: z.string().optional(),
  checkedAt: z.string(),
});

export type PublishVerificationMeta = z.infer<typeof PublishVerificationMetaSchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  text: z.string().nullable(),
  media: z.array(MediaSourceSchema),
  scheduledAt: z.string().datetime(),
  enqueueSeq: z.number().int(),
  status: JobStatusSchema,
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.string().nullable(),
  debugDumpPath: z.string().nullable(),
  verificationMeta: PublishVerificationMetaSchema.nullable(),
  durationMs: z.number().int().nullable(),
  sentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;

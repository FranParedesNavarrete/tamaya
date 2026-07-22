import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Carga .env del repo raíz — 3 niveles arriba desde dist/index.js o src/index.ts
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { and, eq, isNull, lt, lte, asc } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import type { JobMedia } from '@tamaya/db';
import { publishText, publishMedia, applySelectorOverrides } from '@tamaya/core';
import { startHeartbeat } from './heartbeat.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const publishQueue = new Queue('publish-queue', { connection });
const db = getDb();

/**
 * Aplica overrides de selectores desde app_settings (una vez, al arrancar).
 * Los cambios en la UI requieren reiniciar este worker para surtir efecto.
 */
async function loadSelectorOverrides(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, 'selectors.overrides'))
      .limit(1);
    if (rows.length > 0 && rows[0].value) {
      const applied = applySelectorOverrides(JSON.parse(rows[0].value));
      logger.info({ applied }, 'selector overrides applied at startup');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not load selector overrides');
  }
}
await loadSelectorOverrides();

// Latido para que la API sepa que el publisher está vivo (ver /ops/publisher).
const stopHeartbeat = startHeartbeat('worker.publish.heartbeat', logger);

const worker = new Worker(
  'publish-queue',
  async (job) => {
    const { jobId } = job.data as { jobId: string };
    logger.info({ jobId, attempt: job.attemptsMade + 1 }, 'publish start');

    // Cargar job de la DB
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId)).limit(1);
    if (rows.length === 0) throw new Error(`job ${jobId} not found`);
    const row = rows[0];

    if (row.deletedAt) {
      logger.warn({ jobId }, 'job soft-deleted, skipping');
      return { skipped: true };
    }

    if (row.status === 'cancelled') {
      logger.warn({ jobId }, 'job cancelled, skipping');
      return { skipped: true };
    }

    const deferred = await deferIfOlderDueJobExists(row);
    if (deferred) return deferred;

    await db.update(schema.jobs)
      .set({ status: 'publishing', attemptCount: job.attemptsMade + 1 })
      .where(and(eq(schema.jobs.id, jobId), isNull(schema.jobs.deletedAt)));

    // Cargar el canal completo para navegar preferentemente por inviteLink.
    const channelRows = await db.select().from(schema.channels)
      .where(eq(schema.channels.id, row.channelId)).limit(1);
    const channel = channelRows[0];
    const channelIdentifier = {
      name: row.channelName,
      inviteLink: channel?.inviteLink ?? undefined,
      whatsappId: channel?.whatsappId ?? undefined,
    };

    const started = Date.now();
    const media = (row.media ?? []) as JobMedia[];
    const resolvedMedia = media.filter((m) => m.localPath);

    try {
      let result;
      if (resolvedMedia.length === 0) {
        // text-only
        if (!row.text || row.text.length === 0) {
          throw new Error('job has no text and no media');
        }
        result = await publishText({
          channelIdentifier,
          body: row.text,
        });
      } else {
        // media: uno o varios archivos en una misma publicación.
        const mediaPaths = resolvedMedia.map((m) => m.localPath!).filter(Boolean);
        result = await publishMedia({
          channelIdentifier,
          mediaPath: mediaPaths[0],
          mediaPaths,
          mediaKind: inferMediaKindForList(resolvedMedia.map((m) => m.mime)),
          body: row.text ?? undefined,
        });
      }

      const verificationMeta = result.verificationMeta ?? null;

      if (!result.success) {
        // CASO 1 — post-send ambiguo: ya se pulsó Send, el contenido puede
        // haberse publicado. NO relanzamos (evita reintento → duplicado).
        // Marcamos failed con un mensaje inequívoco para revisión manual.
        if (result.postSendMaybeDelivered) {
          await db.update(schema.jobs).set({
            status: 'failed',
            lastError: `POST_SEND_VERIFICATION_FAILED: posible envío ya realizado; no se reintentó para evitar duplicados. (${result.error ?? 'sin detalle'})`,
            debugDumpPath: result.debugDump ?? null,
            verificationMeta,
            durationMs: Date.now() - started,
          }).where(and(eq(schema.jobs.id, jobId), isNull(schema.jobs.deletedAt)));
          logger.warn({ jobId }, 'post-send verification failed — NOT retrying (possible duplicate)');
          return { ok: false, nonRetryable: true };
        }

        // CASO 2 — fallo PRE-send: persistimos y relanzamos para que BullMQ
        // reintente (aún no se ha publicado nada).
        await db.update(schema.jobs).set({
          lastError: result.error ?? 'unknown publish failure',
          debugDumpPath: result.debugDump ?? null,
          verificationMeta,
        }).where(and(eq(schema.jobs.id, jobId), isNull(schema.jobs.deletedAt)));
        throw new Error(result.error ?? 'unknown publish failure');
      }

      // CASO 3 — verificado: enviado.
      await db.update(schema.jobs).set({
        status: 'sent',
        sentAt: new Date(),
        durationMs: Date.now() - started,
        lastError: null,
        debugDumpPath: null,
        verificationMeta,
      }).where(and(eq(schema.jobs.id, jobId), isNull(schema.jobs.deletedAt)));

      logger.info({ jobId, durationMs: result.durationMs }, 'publish success (verified)');
      return { ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId, err: errMsg }, 'publish failed');
      // Persistir el mensaje de error de cada intento (p.ej. perfil bloqueado).
      await db.update(schema.jobs).set({ lastError: errMsg })
        .where(and(eq(schema.jobs.id, jobId), isNull(schema.jobs.deletedAt)));
      throw err;   // BullMQ reintentará según attempts (solo fallos pre-send)
    }
  },
  {
    connection,
    concurrency: 1,   // NUNCA >1 — una cuenta WA = una sesión
  },
);

async function deferIfOlderDueJobExists(row: typeof schema.jobs.$inferSelect): Promise<{ deferred: true; olderJobId: string } | null> {
  const now = new Date();

  // Si por cualquier motivo BullMQ activó un publish antes de hora, lo devolvemos
  // a cola delayed. Normalmente no debería ocurrir.
  if (row.scheduledAt.getTime() > now.getTime()) {
    const delay = Math.max(1000, row.scheduledAt.getTime() - now.getTime());
    await publishQueue.add('publish', { jobId: row.id, scheduledAt: row.scheduledAt.toISOString() }, {
      jobId: `${row.id}:defer:${Date.now()}`,
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });
    logger.warn({ jobId: row.id, delay }, 'publish activated before scheduledAt — deferred');
    return { deferred: true, olderJobId: row.id };
  }

  // Orden estable para lotes: si hay un job MÁS ANTIGUO ya ready y vencido,
  // no publicamos este aún. Lo reencolamos con delay corto y dejamos que el
  // worker drene primero los anteriores. Esto evita que media que resolvió más
  // rápido adelante a jobs creados antes.
  const older = await db.select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.tenantId, row.tenantId),
      isNull(schema.jobs.deletedAt),
      eq(schema.jobs.status, 'ready'),
      lte(schema.jobs.scheduledAt, now),
      lt(schema.jobs.enqueueSeq, row.enqueueSeq),
    ))
    .orderBy(asc(schema.jobs.enqueueSeq))
    .limit(1);

  if (older.length === 0) return null;

  await publishQueue.add('publish', { jobId: row.id, scheduledAt: row.scheduledAt.toISOString() }, {
    jobId: `${row.id}:defer:${Date.now()}`,
    delay: 3000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
  logger.info({ jobId: row.id, olderJobId: older[0].id }, 'deferred publish to preserve createdAt order');
  return { deferred: true, olderJobId: older[0].id };
}

function inferMediaKind(mime: string | undefined): 'image' | 'video' | 'audio' | 'document' {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function inferMediaKindForList(mimes: Array<string | undefined>): 'image' | 'video' | 'audio' | 'document' {
  // Si hay al menos un vídeo, usamos timeouts/flujo de vídeo (el más lento).
  if (mimes.some((m) => m?.startsWith('video/'))) return 'video';
  if (mimes.some((m) => m?.startsWith('image/'))) return 'image';
  if (mimes.some((m) => m?.startsWith('audio/'))) return 'audio';
  return inferMediaKind(mimes[0]);
}

worker.on('failed', async (job, err) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 3);
  if (exhausted) {
    await db.update(schema.jobs).set({
      status: 'failed',
      lastError: err.message,
    }).where(and(eq(schema.jobs.id, job.id!), isNull(schema.jobs.deletedAt)));
  }
});

logger.info('worker-publish started');

const shutdown = async () => {
  logger.info('shutting down worker-publish');
  stopHeartbeat();
  await worker.close();
  await publishQueue.close();
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

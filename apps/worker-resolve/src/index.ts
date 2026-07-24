import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { MediaResolver } from '@tamaya/media-resolver';
import type { JobMedia } from '@tamaya/db';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const connection = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});
const db = getDb();
const resolver = new MediaResolver({
  tmpDir: process.env.TAMAYA_TMP_DIR ?? '/data/tmp',
});

const worker = new Worker(
  'resolve-queue',
  async (job) => {
    const { jobId } = job.data as { jobId: string };
    logger.info({ jobId, attempt: job.attemptsMade + 1 }, 'resolve start');

    // Leer job antes de tocar estado: si fue cancelado o soft-deleted mientras
    // estaba delayed en BullMQ, no debemos reactivarlo accidentalmente.
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId)).limit(1);
    if (rows.length === 0) throw new Error(`job ${jobId} not found`);
    const row = rows[0];
    const mediaList = (row.media ?? []) as JobMedia[];

    if (row.deletedAt) {
      logger.warn({ jobId }, 'job soft-deleted, skipping');
      return { skipped: true };
    }

    if (row.status === 'cancelled') {
      logger.warn({ jobId }, 'job cancelled, skipping');
      return { skipped: true };
    }

    // Actualizar estado solo tras confirmar que sigue activo.
    await db.update(schema.jobs)
      .set({ status: 'resolving', attemptCount: job.attemptsMade + 1 })
      .where(and(eq(schema.jobs.id, jobId), isNull(schema.jobs.deletedAt)));

    // Resolver cada media (si no hay, es text-only y saltamos directo a publish)
    const resolved: JobMedia[] = [];
    for (const m of mediaList) {
      if (m.localPath) {
        // ya resuelto en un intento previo — reutilizamos
        resolved.push(m);
        continue;
      }
      const r = await resolver.resolve(m.source, {
        mimeType: m.mimeType,
        originalName: m.originalName,
      });
      resolved.push({
        ...m,
        localPath: r.localPath,
        mime: r.mime,
        sizeBytes: r.sizeBytes,
      });
      logger.info({ jobId, source: m.source, localPath: r.localPath }, 'media resolved');
    }

    // Persistir media resuelta y marcar ready
    await db.update(schema.jobs)
      .set({ media: resolved, status: 'ready' })
      .where(eq(schema.jobs.id, jobId));

    // Encolar en publish-queue con delay hasta scheduledAt. La media ya queda
    // resuelta desde ahora, pero publish no dispara hasta la hora programada.
    const { enqueuePublish } = await import('./enqueue-publish.js');
    await enqueuePublish({ jobId, scheduledAt: row.scheduledAt.toISOString() });
    logger.info({ jobId, scheduledAt: row.scheduledAt.toISOString() }, 'resolve done, enqueued to publish-queue');

    return { ok: true };
  },
  { connection, concurrency: 5 },
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  logger.error({ jobId: job.id, err: err.message }, 'resolve failed');
  if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
    await db.update(schema.jobs)
      .set({ status: 'failed', lastError: `resolve: ${err.message}` })
      .where(and(eq(schema.jobs.id, job.id!), isNull(schema.jobs.deletedAt)));
  }
});

logger.info('worker-resolve started');

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { eq } from 'drizzle-orm';
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

    // Actualizar estado
    await db.update(schema.jobs)
      .set({ status: 'resolving', attemptCount: job.attemptsMade + 1 })
      .where(eq(schema.jobs.id, jobId));

    // Leer media[] del job
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId)).limit(1);
    if (rows.length === 0) throw new Error(`job ${jobId} not found`);
    const row = rows[0];
    const mediaList = (row.media ?? []) as JobMedia[];

    // Si el job fue cancelado mientras tanto, abortar
    if (row.status === 'cancelled') {
      logger.warn({ jobId }, 'job cancelled, skipping');
      return { skipped: true };
    }

    // Resolver cada media (si no hay, es text-only y saltamos directo a publish)
    const resolved: JobMedia[] = [];
    for (const m of mediaList) {
      if (m.localPath) {
        // ya resuelto en un intento previo — reutilizamos
        resolved.push(m);
        continue;
      }
      const r = await resolver.resolve(m.source);
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

    // Encolar en publish-queue
    const { enqueuePublish } = await import('./enqueue-publish.js');
    await enqueuePublish({ jobId });
    logger.info({ jobId }, 'resolve done, enqueued to publish-queue');

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
      .where(eq(schema.jobs.id, job.id!));
  }
});

logger.info('worker-resolve started');

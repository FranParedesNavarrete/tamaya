import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Carga .env del repo raíz — 3 niveles arriba desde dist/index.js o src/index.ts
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import type { JobMedia } from '@tamaya/db';
import { publishText, publishMedia } from '@tamaya/core';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const db = getDb();

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

    if (row.status === 'cancelled') {
      logger.warn({ jobId }, 'job cancelled, skipping');
      return { skipped: true };
    }

    await db.update(schema.jobs)
      .set({ status: 'publishing', attemptCount: job.attemptsMade + 1 })
      .where(eq(schema.jobs.id, jobId));

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
          channelIdentifier: { name: row.channelName },
          body: row.text,
        });
      } else {
        // media (uno o varios — multi-archivo queda como deuda técnica)
        const first = resolvedMedia[0];
        result = await publishMedia({
          channelIdentifier: { name: row.channelName },
          mediaPath: first.localPath!,
          mediaKind: inferMediaKind(first.mime),
          body: row.text ?? undefined,
        });
      }

      if (!result.success) {
        throw new Error(result.error ?? 'unknown publish failure');
      }

      await db.update(schema.jobs).set({
        status: 'sent',
        sentAt: new Date(),
        durationMs: Date.now() - started,
        lastError: null,
      }).where(eq(schema.jobs.id, jobId));

      logger.info({ jobId, durationMs: result.durationMs }, 'publish success');
      return { ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId, err: errMsg }, 'publish failed');
      throw err;   // BullMQ reintentará según attempts
    }
  },
  {
    connection,
    concurrency: 1,   // NUNCA >1 — una cuenta WA = una sesión
  },
);

function inferMediaKind(mime: string | undefined): 'image' | 'video' | 'audio' | 'document' {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

worker.on('failed', async (job, err) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 3);
  if (exhausted) {
    await db.update(schema.jobs).set({
      status: 'failed',
      lastError: err.message,
    }).where(eq(schema.jobs.id, job.id!));
  }
});

logger.info('worker-publish started');

const shutdown = async () => {
  logger.info('shutting down worker-publish');
  await worker.close();
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

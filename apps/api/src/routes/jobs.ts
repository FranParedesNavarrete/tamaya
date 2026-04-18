import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq, desc, and } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { CreateJobSchema } from '@tamaya/shared-types';
import { enqueueResolve } from '../queue/bullmq.js';

export async function jobsRoutes(app: FastifyInstance) {
  const a = app.withTypeProvider<ZodTypeProvider>();
  const db = getDb();

  // POST /jobs — crear nuevo job programado
  a.post('/', {
    schema: {
      body: CreateJobSchema,
    },
  }, async (req, reply) => {
    const input = req.body;
    const tenantId = 'default';

    const channelRows = await db.select().from(schema.channels)
      .where(eq(schema.channels.id, input.channelId)).limit(1);
    if (channelRows.length === 0) {
      return reply.code(404).send({ error: 'channel not found' });
    }
    const channel = channelRows[0];

    const jobId = randomUUID();
    const scheduledAt = new Date(input.scheduledAt);

    await db.insert(schema.jobs).values({
      id: jobId,
      tenantId,
      channelId: channel.id,
      channelName: channel.name,
      text: input.text ?? null,
      media: input.media,
      scheduledAt,
      status: 'pending',
    });

    await enqueueResolve({
      jobId,
      scheduledAt: scheduledAt.toISOString(),
    });

    req.log.info({ jobId, scheduledAt: input.scheduledAt }, 'job created and enqueued');
    return { id: jobId, status: 'pending' };
  });

  // GET /jobs — listar con filtros
  a.get('/', {
    schema: {
      querystring: z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
  }, async (req) => {
    const { status, limit } = req.query;
    const tenantId = 'default';

    const rows = await db.select().from(schema.jobs)
      .where(
        status
          ? and(eq(schema.jobs.tenantId, tenantId), eq(schema.jobs.status, status as any))
          : eq(schema.jobs.tenantId, tenantId)
      )
      .orderBy(desc(schema.jobs.scheduledAt))
      .limit(limit);

    return rows;
  });

  // GET /jobs/:id
  a.get('/:id', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id))
      .limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // POST /jobs/:id/cancel — marca como cancelled
  a.post('/:id/cancel', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    if (['publishing', 'resolving'].includes(rows[0].status)) {
      return reply.code(409).send({ error: 'cannot cancel job in progress' });
    }
    await db.update(schema.jobs).set({ status: 'cancelled' })
      .where(eq(schema.jobs.id, req.params.id));
    return { id: req.params.id, status: 'cancelled' };
  });

  // DELETE /jobs/:id — borrado real de la fila
  a.delete('/:id', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    if (['publishing', 'resolving'].includes(rows[0].status)) {
      return reply.code(409).send({ error: 'cannot delete job in progress' });
    }
    await db.delete(schema.jobs).where(eq(schema.jobs.id, req.params.id));
    return { id: req.params.id, deleted: true };
  });
}

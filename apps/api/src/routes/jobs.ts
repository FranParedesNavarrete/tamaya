import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq, desc, and, gte, lte, like, sql, type SQL } from 'drizzle-orm';
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

  // GET /jobs — listar con filtros + búsqueda
  a.get('/', {
    schema: {
      querystring: z.object({
        status: z.string().optional(),
        channelId: z.string().uuid().optional(),
        q: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
  }, async (req) => {
    const { status, channelId, q, from, to, limit, offset } = req.query;
    const tenantId = 'default';

    const conditions: SQL[] = [eq(schema.jobs.tenantId, tenantId)];
    if (status) conditions.push(eq(schema.jobs.status, status as any));
    if (channelId) conditions.push(eq(schema.jobs.channelId, channelId));
    if (q) conditions.push(like(schema.jobs.text, `%${q}%`));
    if (from) conditions.push(gte(schema.jobs.scheduledAt, new Date(from)));
    if (to) conditions.push(lte(schema.jobs.scheduledAt, new Date(to)));

    const rows = await db.select().from(schema.jobs)
      .where(and(...conditions))
      .orderBy(desc(schema.jobs.scheduledAt))
      .limit(limit)
      .offset(offset);

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

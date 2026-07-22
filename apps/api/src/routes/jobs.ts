import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq, desc, and, gte, lte, like, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { CreateJobSchema } from '@tamaya/shared-types';
import { enqueueResolve, requeuePublish } from '../queue/bullmq.js';

function parseRequestedDateTime(input: { scheduledAt?: string; datetime?: string; publishNow?: boolean }): Date {
  const requested = input.datetime ?? input.scheduledAt;
  if (input.publishNow || requested === 'now') return new Date();
  if (!requested) throw new Error('One of scheduledAt, datetime or publishNow is required');

  // Nuevo formato recomendado: hora local Madrid sin timezone.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(requested)) {
    return localMadridDateTimeToUtc(requested);
  }

  // Compatibilidad: ISO 8601 con timezone.
  const d = new Date(requested);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid datetime: ${requested}`);
  return d;
}

function localMadridDateTimeToUtc(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`invalid datetime: ${value}`);
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as [number, number, number, number, number, number, number];
  const asIfUtc = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const offsetMs = timeZoneOffsetMs('Europe/Madrid', asIfUtc);
  return new Date(asIfUtc.getTime() - offsetMs);
}

function timeZoneOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const zonedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return zonedAsUtc - date.getTime();
}

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
    const scheduledAt = parseRequestedDateTime(input);
    const lockName = `tamaya_enqueue_seq_${tenantId}`;
    await db.execute(sql`SELECT GET_LOCK(${lockName}, 5)`);
    let enqueueSeq = 1;
    try {
      const [{ nextSeq }] = await db
        .select({ nextSeq: sql<number>`coalesce(max(${schema.jobs.enqueueSeq}), 0) + 1` })
        .from(schema.jobs)
        .where(eq(schema.jobs.tenantId, tenantId));
      enqueueSeq = Number(nextSeq ?? 1);

      await db.insert(schema.jobs).values({
        id: jobId,
        tenantId,
        channelId: channel.id,
        channelName: channel.name,
        text: input.text ?? null,
        media: input.media,
        scheduledAt,
        enqueueSeq,
        status: 'pending',
      });
    } finally {
      await db.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
    }

    await enqueueResolve({
      jobId,
      scheduledAt: scheduledAt.toISOString(),
    });

    req.log.info({ jobId, scheduledAt: scheduledAt.toISOString(), requestedAt: input.scheduledAt ?? input.datetime }, 'job created and enqueued');
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

    const conditions: SQL[] = [
      eq(schema.jobs.tenantId, tenantId),
      isNull(schema.jobs.deletedAt),   // excluir soft-deleted
    ];
    if (status) conditions.push(eq(schema.jobs.status, status as any));
    if (channelId) conditions.push(eq(schema.jobs.channelId, channelId));
    if (q) conditions.push(like(schema.jobs.text, `%${q}%`));
    if (from) conditions.push(gte(schema.jobs.scheduledAt, new Date(from)));
    if (to) conditions.push(lte(schema.jobs.scheduledAt, new Date(to)));

    const rows = await db.select().from(schema.jobs)
      .where(and(...conditions))
      .orderBy(desc(schema.jobs.enqueueSeq))
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
    if (rows[0].deletedAt) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // POST /jobs/:id/cancel — marca como cancelled
  a.post('/:id/cancel', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    if (rows[0].deletedAt) return reply.code(404).send({ error: 'not found' });
    if (['publishing', 'resolving'].includes(rows[0].status)) {
      return reply.code(409).send({ error: 'cannot cancel job in progress' });
    }
    await db.update(schema.jobs).set({ status: 'cancelled' })
      .where(eq(schema.jobs.id, req.params.id));
    return { id: req.params.id, status: 'cancelled' };
  });

  // POST /jobs/:id/requeue-publish — reencola en publish-queue (acción operativa).
  // Útil cuando el fallo fue operativo (worker parado, perfil bloqueado) y ya
  // se ha corregido. No publica directamente: deja que worker-publish consuma.
  a.post('/:id/requeue-publish', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    const job = rows[0];
    if (job.deletedAt) return reply.code(404).send({ error: 'not found' });
    if (!['ready', 'failed'].includes(job.status)) {
      return reply.code(409).send({
        error: `solo se puede reencolar un job en estado 'ready' o 'failed' (actual: ${job.status})`,
      });
    }

    // Si estaba failed, lo devolvemos a 'ready' y limpiamos el error previo.
    if (job.status === 'failed') {
      await db.update(schema.jobs)
        .set({ status: 'ready', lastError: null })
        .where(and(eq(schema.jobs.id, job.id), isNull(schema.jobs.deletedAt)));
    }

    await requeuePublish(job.id);
    req.log.info({ jobId: job.id }, 'job requeued to publish-queue');
    return { id: job.id, status: 'ready', requeued: true };
  });

  // DELETE /jobs/:id — soft-delete (marca deletedAt, nunca borra la fila)
  a.delete('/:id', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    // Ya eliminado → idempotente pero informamos 404 para no listarlo como activo.
    if (rows[0].deletedAt) return reply.code(404).send({ error: 'not found' });
    if (['publishing', 'resolving'].includes(rows[0].status)) {
      return reply.code(409).send({ error: 'cannot delete job in progress' });
    }
    await db.update(schema.jobs)
      .set({ deletedAt: new Date() })
      .where(eq(schema.jobs.id, req.params.id));
    return { id: req.params.id, deleted: true };
  });
}

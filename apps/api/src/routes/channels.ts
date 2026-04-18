import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { CreateChannelSchema, UpdateChannelSchema } from '@tamaya/shared-types';

export async function channelsRoutes(app: FastifyInstance) {
  const a = app.withTypeProvider<ZodTypeProvider>();
  const db = getDb();
  const tenantId = 'default';

  // GET /channels — solo activos
  a.get('/', async () => {
    return db.select().from(schema.channels).where(and(
      eq(schema.channels.tenantId, tenantId),
      isNull(schema.channels.deletedAt),
    ));
  });

  // GET /channels/:id
  a.get('/:id', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.channels)
      .where(eq(schema.channels.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // POST /channels
  a.post('/', {
    schema: { body: CreateChannelSchema },
  }, async (req) => {
    const id = randomUUID();
    await db.insert(schema.channels).values({
      id,
      tenantId,
      acronym: req.body.acronym ?? null,
      name: req.body.name,
      description: req.body.description ?? null,
      inviteLink: req.body.inviteLink ?? null,
      whatsappId: req.body.whatsappId ?? null,
    });
    return { id };
  });

  // PUT /channels/:id
  a.put('/:id', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateChannelSchema,
    },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.channels)
      .where(eq(schema.channels.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });

    await db.update(schema.channels).set({
      ...(req.body.acronym !== undefined && { acronym: req.body.acronym }),
      ...(req.body.name !== undefined && { name: req.body.name }),
      ...(req.body.description !== undefined && { description: req.body.description }),
      ...(req.body.inviteLink !== undefined && { inviteLink: req.body.inviteLink }),
      ...(req.body.whatsappId !== undefined && { whatsappId: req.body.whatsappId }),
    }).where(eq(schema.channels.id, req.params.id));
    return { id: req.params.id };
  });

  // DELETE /channels/:id — soft delete
  a.delete('/:id', {
    schema: { params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.channels)
      .where(eq(schema.channels.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });

    await db.update(schema.channels)
      .set({ deletedAt: new Date() })
      .where(eq(schema.channels.id, req.params.id));
    return { id: req.params.id, deleted: true };
  });
}

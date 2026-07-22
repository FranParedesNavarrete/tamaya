import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { jobsRoutes } from './routes/jobs.js';
import { channelsRoutes } from './routes/channels.js';
import { mediaRoutes } from './routes/media.js';
import { statsRoutes } from './routes/stats.js';
import { settingsRoutes } from './routes/settings.js';
import { opsRoutes } from './routes/ops.js';
import { registerAuth } from './auth.js';
import { closeQueue } from './queue/bullmq.js';

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: (process.env.API_CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  });
  await app.register(multipart, {
    limits: { fileSize: 100 * 1024 * 1024 },   // 100 MB
  });

  // Guard de autenticación por Bearer token. /health y GET /settings/security
  // quedan públicos; el resto exige token una vez configurado (ver auth.ts).
  registerAuth(app);

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(jobsRoutes, { prefix: '/jobs' });
  await app.register(channelsRoutes, { prefix: '/channels' });
  await app.register(mediaRoutes, { prefix: '/media' });
  await app.register(statsRoutes, { prefix: '/stats' });
  await app.register(settingsRoutes, { prefix: '/settings' });
  await app.register(opsRoutes, { prefix: '/ops' });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });

  const shutdown = async () => {
    app.log.info('shutting down');
    await closeQueue();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

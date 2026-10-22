import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { jobsRoutes } from './routes/jobs.js';
import { channelsRoutes } from './routes/channels.js';
import { mediaRoutes } from './routes/media.js';
import { statsRoutes } from './routes/stats.js';
import { settingsRoutes } from './routes/settings.js';
import { opsRoutes } from './routes/ops.js';
import { registerAuth } from './auth.js';
import { closeQueue } from './queue/bullmq.js';
import { startInsightsScheduler } from './insights-scheduler.js';

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

  // Documentación OpenAPI en /docs (Swagger UI). Debe registrarse antes que las
  // rutas para que @fastify/swagger las recoja. Las rutas sin schema aparecen
  // igualmente (método + path) agrupadas por su prefijo.
  await app.register(swagger, {
    openapi: {
      info: { title: 'Tamaya API', version: '0.4.0', description: 'API de programación y publicación en canales de WhatsApp.' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
    },
    transform: (args) => {
      // Rutas sin `schema` llegan con schema undefined: les damos uno mínimo con tag.
      const out = jsonSchemaTransform({ ...args, schema: args.schema ?? {} });
      const schema = out.schema as { tags?: string[] };
      if (!schema.tags) schema.tags = [args.url.split('/')[1] || 'general'];
      return out;
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { persistAuthorization: true, docExpansion: 'list' },
  });

  // Guard de autenticación por Bearer token. /health y GET /settings/security
  // y /docs quedan públicos; el resto exige token una vez configurado (ver auth.ts).
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

  const stopInsightsScheduler = startInsightsScheduler();

  const shutdown = async () => {
    app.log.info('shutting down');
    stopInsightsScheduler();
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

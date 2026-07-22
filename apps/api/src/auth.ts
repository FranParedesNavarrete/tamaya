import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isApiTokenConfigured, verifyApiToken } from './settings/store.js';

/**
 * Rutas siempre públicas (no requieren token nunca):
 *   - GET /health              → healthcheck / readiness
 *   - GET /settings/security   → estado de configuración ({ apiTokenConfigured })
 *                                No expone ningún secreto, solo un booleano.
 */
function isPublicRoute(method: string, path: string): boolean {
  if (path === '/health') return true;
  if (method === 'GET' && path === '/settings/security') return true;
  return false;
}

/** Extrae el token de `Authorization: Bearer <t>` o `X-API-Token: <t>`. */
function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t) return t;
  }
  const xToken = req.headers['x-api-token'];
  if (typeof xToken === 'string' && xToken.trim()) return xToken.trim();
  return null;
}

/**
 * Registra el guard de autenticación por Bearer token.
 *
 * Comportamiento (ver tarea E del master prompt):
 *   - `API_AUTH_DISABLED=true`  → auth desactivada (SOLO desarrollo).
 *   - Rutas públicas            → siempre permitidas.
 *   - Sin token configurado     → API abierta. Esto permite el bootstrap
 *                                 (generar el primer token) y no bloquea el
 *                                 primer arranque de la app.
 *   - Con token configurado     → todo lo no-público exige token válido
 *                                 (401 si falta o es inválido).
 */
export function registerAuth(app: FastifyInstance): void {
  const disabled = process.env.API_AUTH_DISABLED === 'true';
  if (disabled) {
    app.log.warn('API_AUTH_DISABLED=true — autenticación DESACTIVADA (no usar en producción)');
  }

  app.addHook('onRequest', async (req, reply) => {
    if (disabled) return;

    const path = req.url.split('?')[0];
    if (isPublicRoute(req.method, path)) return;

    // Sin token configurado → API abierta (bootstrap + primer arranque).
    if (!(await isApiTokenConfigured())) return;

    const provided = extractToken(req);
    if (!provided) {
      return reply.code(401).send({
        error: 'API token requerido',
        code: 'API_TOKEN_MISSING',
      });
    }
    if (!(await verifyApiToken(provided))) {
      return reply.code(401).send({
        error: 'API token inválido',
        code: 'API_TOKEN_INVALID',
      });
    }
  });
}

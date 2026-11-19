import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isApiTokenConfigured, verifyApiToken } from './settings/store.js';
import type { AuthConfig } from './auth-config.js';

/**
 * Rutas siempre públicas (no requieren token nunca):
 *   - GET /health              → healthcheck / readiness
 *   - GET /settings/security   → estado de configuración ({ apiTokenConfigured,
 *                                apiTokenSource }). No expone ningún secreto.
 *
 * `/docs` y `/docs/*` (Swagger UI + spec) solo son públicas si
 * `TAMAYA_DOCS_ENABLED=true` (por defecto en desarrollo); en producción exigen
 * token como el resto de rutas.
 */
function isPublicRoute(method: string, path: string, docsPublic: boolean): boolean {
  if (path === '/health') return true;
  if (method === 'GET' && path === '/settings/security') return true;
  if (docsPublic && method === 'GET' && (path === '/docs' || path.startsWith('/docs/'))) return true;
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

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Comparación en tiempo constante. Se comparan los SHA-256 de ambos valores:
 * siempre miden 32 bytes, así que `timingSafeEqual` no lanza por longitudes
 * distintas ni se filtra la longitud del token.
 */
export function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/** Acceso al token guardado en BD (inyectable para poder probar sin BD). */
export interface StoredTokenStore {
  isConfigured: () => Promise<boolean>;
  verify: (candidate: string) => Promise<boolean>;
}

const defaultStore: StoredTokenStore = { isConfigured: isApiTokenConfigured, verify: verifyApiToken };

let current: AuthConfig | null = null;

/** Configuración de auth activa (la fija `registerAuth` al arrancar). */
export function getAuthConfig(): AuthConfig {
  if (!current) throw new Error('auth no inicializada');
  return current;
}

/** Origen del token que valida la API, para mostrarlo en Ajustes. */
export async function describeTokenSource(
  store: StoredTokenStore = defaultStore,
): Promise<{ apiTokenConfigured: boolean; apiTokenSource: 'env' | 'stored' | 'none' }> {
  const cfg = getAuthConfig();
  if (cfg.mode === 'env') return { apiTokenConfigured: true, apiTokenSource: 'env' };
  if (cfg.mode === 'stored' && (await store.isConfigured())) {
    return { apiTokenConfigured: true, apiTokenSource: 'stored' };
  }
  return { apiTokenConfigured: false, apiTokenSource: 'none' };
}

/**
 * Registra el guard de autenticación por Bearer token. La configuración sale de
 * `resolveAuthConfig` (ver auth-config.ts):
 *   - `disabled` → sin auth (solo desarrollo).
 *   - `env`      → exige `TAMAYA_API_TOKEN`; con `allowStoredToken` acepta además
 *                  el token antiguo guardado en BD (migración).
 *   - `stored`   → solo desarrollo: API abierta hasta generar un token desde
 *                  Ajustes, y entonces exige ese.
 */
export function registerAuth(
  app: FastifyInstance,
  cfg: AuthConfig,
  store: StoredTokenStore = defaultStore,
): void {
  current = cfg;
  if (cfg.mode === 'disabled') {
    app.log.warn('API_AUTH_DISABLED=true — autenticación DESACTIVADA (solo desarrollo)');
  } else if (cfg.mode === 'stored') {
    app.log.warn('TAMAYA_DEV_TOKEN_BOOTSTRAP=true — token guardado en BD (solo desarrollo)');
  } else if (cfg.allowStoredToken) {
    app.log.warn('TAMAYA_ALLOW_STORED_TOKEN=true — se acepta también el token antiguo guardado en BD (transitorio)');
  }

  app.addHook('onRequest', async (req, reply) => {
    if (cfg.mode === 'disabled') return;

    const path = req.url.split('?')[0];
    if (isPublicRoute(req.method, path, cfg.docsPublic)) return;

    // Modo desarrollo con bootstrap: sin token guardado todavía → API abierta.
    if (cfg.mode === 'stored' && !(await store.isConfigured())) return;

    const provided = extractToken(req);
    if (!provided) {
      return reply.code(401).send({
        error: 'API token requerido',
        code: 'API_TOKEN_MISSING',
      });
    }

    let ok = false;
    if (cfg.mode === 'env' && cfg.envToken) ok = tokensMatch(provided, cfg.envToken);
    if (!ok && cfg.allowStoredToken) ok = await store.verify(provided);
    if (!ok) {
      return reply.code(401).send({
        error: 'API token inválido',
        code: 'API_TOKEN_INVALID',
      });
    }
  });
}

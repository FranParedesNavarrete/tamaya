import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  EDITABLE_SELECTORS_DEFAULTS,
  EDITABLE_SELECTOR_KEYS,
  NON_EDITABLE_SELECTOR_KEYS,
  SelectorOverridesSchema,
  type EditableSelectorKey,
  type SelectorOverrides,
} from '@tamaya/shared-types';
import {
  isApiTokenConfigured,
  generateAndStoreApiToken,
  getSelectorOverrides,
  setSelectorOverrides,
  deleteSetting,
  SELECTOR_OVERRIDES_KEY,
} from '../settings/store.js';
import { controlFetch, ControlUnavailableError } from '../control-client.js';

/** Merge defaults + overrides → selectores efectivos (solo claves editables). */
function effectiveSelectors(overrides: SelectorOverrides): Record<EditableSelectorKey, string[]> {
  const out = {} as Record<EditableSelectorKey, string[]>;
  for (const key of EDITABLE_SELECTOR_KEYS) {
    const ov = overrides[key];
    out[key] = Array.isArray(ov) && ov.length > 0 ? [...ov] : [...EDITABLE_SELECTORS_DEFAULTS[key]];
  }
  return out;
}

/**
 * Endpoints de configuración de la aplicación.
 *
 *  Seguridad API (Iteración 1):
 *    GET  /settings/security             → { apiTokenConfigured }  (público)
 *    POST /settings/security/api-token   → genera/rota el token
 *
 *  WhatsApp (proxy al control server nativo, Iteración 2):
 *    GET  /settings/whatsapp/status
 *    POST /settings/whatsapp/login/start
 *    GET  /settings/whatsapp/login/qr
 *    POST /settings/whatsapp/session/reset
 *
 *  Selectores editables (Iteración 2):
 *    GET  /settings/selectors
 *    PUT  /settings/selectors
 *    POST /settings/selectors/reset
 *
 * Todas las rutas salvo GET /settings/security están protegidas por el guard
 * global de token (auth.ts).
 */
export async function settingsRoutes(app: FastifyInstance) {
  const a = app.withTypeProvider<ZodTypeProvider>();

  // ---------- Seguridad API ----------
  a.get('/security', async () => {
    return { apiTokenConfigured: await isApiTokenConfigured() };
  });

  a.post('/security/api-token', async () => {
    const token = await generateAndStoreApiToken();
    return { token, shownOnce: true };
  });

  // ---------- WhatsApp (proxy al control server nativo) ----------
  // La API no expone TAMAYA_CONTROL_URL; solo reenvía y traduce errores a 503.
  async function proxy(reply: import('fastify').FastifyReply, method: 'GET' | 'POST', path: string) {
    try {
      const { status, body } = await controlFetch(method, path);
      if (status === 401) {
        return reply.code(503).send({ error: 'worker-publish control server auth failed' });
      }
      return reply.code(status).send(body);
    } catch (err) {
      if (err instanceof ControlUnavailableError) {
        return reply.code(503).send({ error: 'worker-publish control server not available' });
      }
      throw err;
    }
  }

  a.get('/whatsapp/status', async (_req, reply) => proxy(reply, 'GET', '/whatsapp/status'));
  a.post('/whatsapp/login/start', async (_req, reply) => proxy(reply, 'POST', '/whatsapp/login/start'));
  a.get('/whatsapp/login/qr', async (_req, reply) => proxy(reply, 'GET', '/whatsapp/login/qr'));
  a.post('/whatsapp/session/reset', async (_req, reply) => proxy(reply, 'POST', '/whatsapp/session/reset'));

  // ---------- Selectores editables ----------
  a.get('/selectors', async () => {
    const overrides = await getSelectorOverrides();
    return {
      defaults: EDITABLE_SELECTORS_DEFAULTS,
      overrides,
      effective: effectiveSelectors(overrides),
      editableKeys: EDITABLE_SELECTOR_KEYS,
      nonEditableKeys: NON_EDITABLE_SELECTOR_KEYS,
    };
  });

  a.put('/selectors', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'body debe ser un objeto JSON de overrides' });
    }
    // Rechazo explícito de claves desconocidas o no editables (funciones).
    const unknown = Object.keys(body).filter(
      (k) => !(EDITABLE_SELECTOR_KEYS as string[]).includes(k),
    );
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `claves no editables o desconocidas: ${unknown.join(', ')}` });
    }
    const parsed = SelectorOverridesSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'overrides inválidos: cada clave debe ser un array no vacío de strings no vacíos',
        details: parsed.error.issues,
      });
    }
    await setSelectorOverrides(parsed.data);
    return {
      ok: true,
      overrides: parsed.data,
      effective: effectiveSelectors(parsed.data),
      note: 'Reinicia worker-publish / control-server para que los cambios surtan efecto.',
    };
  });

  a.post('/selectors/reset', async () => {
    await deleteSetting(SELECTOR_OVERRIDES_KEY);
    return {
      ok: true,
      overrides: {},
      effective: effectiveSelectors({}),
      note: 'Reinicia worker-publish / control-server para que los cambios surtan efecto.',
    };
  });
}

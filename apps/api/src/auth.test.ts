/**
 * Tests de autenticación: configuración (auth-config), guard HTTP (auth) y
 * arranque real del proceso. Ejecutar con `npm test -w apps/api`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { AuthConfigError, resolveAuthConfig, type AuthConfig } from './auth-config.js';
import { registerAuth, tokensMatch, type StoredTokenStore } from './auth.js';

const TOKEN = 'a'.repeat(40);
const OLD = 'tamaya_token_antiguo';
const noStore: StoredTokenStore = { isConfigured: async () => false, verify: async () => false };
const oldStore: StoredTokenStore = { isConfigured: async () => true, verify: async (c) => c === OLD };

const prodEnv = { NODE_ENV: 'production', TAMAYA_API_TOKEN: TOKEN };

// ---------- resolveAuthConfig ----------

test('producción sin TAMAYA_API_TOKEN → error', () => {
  assert.throws(() => resolveAuthConfig({ NODE_ENV: 'production' }), AuthConfigError);
});

test('TAMAYA_REQUIRE_ENV_TOKEN=true exige token aunque NODE_ENV no sea production', () => {
  assert.throws(() => resolveAuthConfig({ TAMAYA_REQUIRE_ENV_TOKEN: 'true' }), /TAMAYA_API_TOKEN/);
});

test('token de menos de 32 caracteres → error en producción', () => {
  assert.throws(() => resolveAuthConfig({ NODE_ENV: 'production', TAMAYA_API_TOKEN: 'corto' }), /demasiado corto/);
});

test('el mensaje de error nunca contiene el token', () => {
  const secreto = 'secreto-corto-123';
  try {
    resolveAuthConfig({ NODE_ENV: 'production', TAMAYA_API_TOKEN: secreto });
    assert.fail('debía lanzar');
  } catch (e) {
    assert.ok(!(e as Error).message.includes(secreto));
  }
});

test('API_AUTH_DISABLED=true se rechaza en producción', () => {
  assert.throws(() => resolveAuthConfig({ ...prodEnv, API_AUTH_DISABLED: 'true' }), /API_AUTH_DISABLED/);
});

test('producción válida: modo env, docs protegidas por defecto', () => {
  const c = resolveAuthConfig(prodEnv);
  assert.equal(c.mode, 'env');
  assert.equal(c.docsPublic, false);
  assert.equal(c.allowStoredToken, false);
});

test('TAMAYA_DOCS_ENABLED=true hace públicas las docs en producción', () => {
  assert.equal(resolveAuthConfig({ ...prodEnv, TAMAYA_DOCS_ENABLED: 'true' }).docsPublic, true);
});

test('desarrollo: sin nada configurado se niega; con opt-in explícito vale', () => {
  assert.throws(() => resolveAuthConfig({}), AuthConfigError);
  assert.equal(resolveAuthConfig({ TAMAYA_DEV_TOKEN_BOOTSTRAP: 'true' }).mode, 'stored');
  assert.equal(resolveAuthConfig({ API_AUTH_DISABLED: 'true' }).mode, 'disabled');
  assert.equal(resolveAuthConfig({ TAMAYA_API_TOKEN: 'x' }).mode, 'env');
  assert.equal(resolveAuthConfig({ TAMAYA_DEV_TOKEN_BOOTSTRAP: 'true' }).docsPublic, true);
});

// ---------- tokensMatch ----------

test('tokensMatch: iguales sí, distintos y de distinta longitud no (sin lanzar)', () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch(TOKEN + 'x', TOKEN), false);
  assert.equal(tokensMatch('', TOKEN), false);
});

// ---------- guard HTTP ----------

async function build(cfg: AuthConfig, store: StoredTokenStore = noStore) {
  const app = Fastify();
  registerAuth(app, cfg, store);
  app.get('/health', async () => ({ ok: true }));
  app.get('/settings/security', async () => ({ ok: true }));
  app.get('/jobs', async () => ({ jobs: [] }));
  app.get('/docs/json', async () => ({ openapi: '3' }));
  await app.ready();
  return app;
}

test('guard (producción): sin token 401, token erróneo 401, correcto 200', async () => {
  const app = await build(resolveAuthConfig(prodEnv));
  assert.equal((await app.inject('/jobs')).statusCode, 401);
  assert.equal((await app.inject({ url: '/jobs', headers: { authorization: 'Bearer incorrecto' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/jobs', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/jobs', headers: { 'x-api-token': TOKEN } })).statusCode, 200);
  await app.close();
});

test('guard (producción): /health y /settings/security siguen públicos', async () => {
  const app = await build(resolveAuthConfig(prodEnv));
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/settings/security')).statusCode, 200);
  await app.close();
});

test('guard (producción): /docs exige token, no queda abierta', async () => {
  const app = await build(resolveAuthConfig(prodEnv));
  assert.equal((await app.inject('/docs/json')).statusCode, 401);
  assert.equal((await app.inject({ url: '/docs/json', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 200);
  await app.close();
});

test('guard (desarrollo): /docs pública', async () => {
  const app = await build(resolveAuthConfig({ TAMAYA_API_TOKEN: TOKEN }));
  assert.equal((await app.inject('/docs/json')).statusCode, 200);
  assert.equal((await app.inject('/jobs')).statusCode, 401);
  await app.close();
});

test('token antiguo de BD: rechazado por defecto, aceptado solo con TAMAYA_ALLOW_STORED_TOKEN', async () => {
  const strict = await build(resolveAuthConfig(prodEnv), oldStore);
  assert.equal((await strict.inject({ url: '/jobs', headers: { authorization: `Bearer ${OLD}` } })).statusCode, 401);
  await strict.close();

  const transitional = await build(resolveAuthConfig({ ...prodEnv, TAMAYA_ALLOW_STORED_TOKEN: 'true' }), oldStore);
  assert.equal((await transitional.inject({ url: '/jobs', headers: { authorization: `Bearer ${OLD}` } })).statusCode, 200);
  assert.equal((await transitional.inject({ url: '/jobs', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 200);
  assert.equal((await transitional.inject({ url: '/jobs', headers: { authorization: 'Bearer otro' } })).statusCode, 401);
  await transitional.close();
});

// ---------- arranque real ----------

function boot(env: Record<string, string>) {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('arranque: producción sin TAMAYA_API_TOKEN sale con código != 0 y el mensaje', () => {
  const r = boot({ NODE_ENV: 'production' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Falta TAMAYA_API_TOKEN/);
});

test('arranque: producción con API_AUTH_DISABLED=true sale con código != 0', () => {
  const r = boot({ ...prodEnv, API_AUTH_DISABLED: 'true' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /API_AUTH_DISABLED/);
  assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
});

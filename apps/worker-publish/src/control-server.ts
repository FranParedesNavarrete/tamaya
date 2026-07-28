/**
 * Control server nativo de worker-publish (Iteración 2).
 *
 * Servicio HTTP LOCAL (no expuesto públicamente) que permite administrar la
 * sesión de WhatsApp Web desde la UI/API sin abrir ninguna ventana gráfica:
 *   - consultar estado de sesión/login,
 *   - iniciar la vinculación headless y exponer el QR,
 *   - resetear la sesión.
 *
 * Corre NATIVO en el host (igual que worker-publish) porque usa Playwright/
 * Chromium sobre el mismo `userDataDir`. La API (en Docker) actúa de gateway
 * protegido y lo alcanza vía TAMAYA_CONTROL_URL (host.docker.internal:3010).
 *
 * IMPORTANTE (bloqueo de perfil): Chromium no admite dos procesos sobre el
 * mismo `userDataDir`. Haz la vinculación cuando worker-publish no esté
 * publicando (idealmente `pm2 stop tamaya-worker-publish` durante el login).
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Carga .env del repo raíz — 3 niveles arriba desde dist/control-server.js o src/.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { createServer, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import {
  launchPersistentContextForTenant,
  sessionExists,
  wipeSession,
  applySelectorOverrides,
  SELECTORS,
  config,
} from '@tamaya/core';
import type { BrowserContext, Page } from 'playwright';
import { startHeartbeat } from './heartbeat.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
});

const HOST = process.env.TAMAYA_CONTROL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TAMAYA_CONTROL_PORT ?? 3010);
const CONTROL_TOKEN = process.env.TAMAYA_CONTROL_TOKEN?.trim() || '';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const PM2_BIN = process.env.TAMAYA_PM2_BIN ?? 'pm2';
const PM2_PUBLISH_NAME = process.env.TAMAYA_PM2_PUBLISH_NAME ?? 'tamaya-worker-publish';
const execFileAsync = promisify(execFile);

// En Linux, para que un contenedor Docker alcance el servicio nativo vía
// host.docker.internal/host-gateway, normalmente el proceso no puede escuchar
// solo en 127.0.0.1. Si se expone fuera de loopback exigimos token interno.
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && CONTROL_TOKEN.length === 0) {
  throw new Error('TAMAYA_CONTROL_TOKEN is required when TAMAYA_CONTROL_HOST is not loopback');
}

type LoginState = 'idle' | 'starting' | 'qr' | 'authenticated' | 'ready' | 'error';

let loginState: LoginState = 'idle';
let lastError: string | null = null;
let updatedAt = new Date().toISOString();
let context: BrowserContext | null = null;
let page: Page | null = null;

function setState(s: LoginState, err: string | null = null): void {
  loginState = s;
  lastError = err;
  updatedAt = new Date().toISOString();
  logger.info({ loginState, lastError }, 'state changed');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ¿Alguno de los selectores está visible ahora mismo? */
async function anyVisible(p: Page, selectors: readonly string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      if (await p.locator(sel).first().isVisible()) return true;
    } catch {
      // selector inválido/desconectado — probar siguiente
    }
  }
  return false;
}

/** Cierra el contexto si está abierto (libera el lock del userDataDir). */
async function cleanup(): Promise<void> {
  if (context) {
    try {
      await context.close();
    } catch (err) {
      logger.warn({ err: errMsg(err) }, 'error closing context');
    }
  }
  context = null;
  page = null;
}

/**
 * Vigila el estado del login: detecta QR o app lista. Al detectar la app,
 * marca 'ready' y cierra el contexto (la sesión ya quedó persistida en
 * userDataDir) para liberar el perfil.
 */
async function watchLogin(): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (!page) return;
      if (await anyVisible(page, SELECTORS.appReady)) {
        setState('ready');
        await cleanup();
        return;
      }
      if (await anyVisible(page, SELECTORS.loginQrCanvas)) {
        if (loginState !== 'qr') setState('qr');
      }
      await sleep(2000);
    }
    setState('error', 'login timeout — QR no escaneado a tiempo');
    await cleanup();
  } catch (err) {
    setState('error', errMsg(err));
    await cleanup();
  }
}

async function startLogin(): Promise<{ started: boolean; error?: string }> {
  // Ya en progreso → idempotente.
  if (loginState === 'starting' || loginState === 'qr') return { started: true };

  setState('starting');
  try {
    // owner 'control-server' → si worker-publish está publicando, error claro.
    context = await launchPersistentContextForTenant('control-server');
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
    void watchLogin();
    return { started: true };
  } catch (err) {
    const msg = errMsg(err);
    await cleanup();
    setState('error', msg);
    return { started: false, error: msg };
  }
}

async function getQr(): Promise<{ qrDataUrl?: string; state: LoginState }> {
  if (loginState === 'qr' && page) {
    for (const sel of SELECTORS.loginQrCanvas) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible()) {
          const buf = await loc.screenshot({ type: 'png' });
          return { qrDataUrl: `data:image/png;base64,${buf.toString('base64')}`, state: loginState };
        }
      } catch {
        // probar siguiente selector
      }
    }
  }
  return { state: loginState };
}

async function resetSession(): Promise<{ ok: true }> {
  await cleanup();
  wipeSession();
  setState('idle');
  return { ok: true };
}

async function restartPublisher(): Promise<{ ok: boolean; process: string; stdout?: string; stderr?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(PM2_BIN, ['restart', PM2_PUBLISH_NAME, '--update-env'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    logger.info({ process: PM2_PUBLISH_NAME }, 'worker-publish restart requested');
    return { ok: true, process: PM2_PUBLISH_NAME, stdout, stderr };
  } catch (err) {
    const msg = errMsg(err);
    logger.error({ err: msg, process: PM2_PUBLISH_NAME }, 'worker-publish restart failed');
    return { ok: false, process: PM2_PUBLISH_NAME, error: msg };
  }
}

function statusPayload() {
  return {
    sessionExists: sessionExists(),
    loginState,
    lastError,
    updatedAt,
    headless: config.playwright.headless,
  };
}

/** Aplica overrides de selectores desde app_settings (una vez, al arrancar). */
async function loadSelectorOverrides(): Promise<void> {
  try {
    const rows = await getDb()
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, 'selectors.overrides'))
      .limit(1);
    if (rows.length > 0 && rows[0].value) {
      const parsed = JSON.parse(rows[0].value);
      const applied = applySelectorOverrides(parsed);
      logger.info({ applied }, 'selector overrides applied at startup');
    }
  } catch (err) {
    logger.warn({ err: errMsg(err) }, 'could not load selector overrides (using defaults)');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true, service: 'worker-publish-control', ts: new Date().toISOString() });
      }

      if (CONTROL_TOKEN) {
        const provided = req.headers['x-tamaya-control-token'];
        if (provided !== CONTROL_TOKEN) {
          return json(res, 401, { error: 'control token inválido' });
        }
      }
      if (method === 'GET' && path === '/whatsapp/status') {
        return json(res, 200, statusPayload());
      }
      if (method === 'POST' && path === '/whatsapp/login/start') {
        const r = await startLogin();
        return json(res, 200, r);
      }
      if (method === 'GET' && path === '/whatsapp/login/qr') {
        return json(res, 200, await getQr());
      }
      if (method === 'POST' && path === '/whatsapp/session/reset') {
        return json(res, 200, await resetSession());
      }
      if (method === 'POST' && path === '/publisher/restart') {
        const r = await restartPublisher();
        return json(res, r.ok ? 200 : 500, r);
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: errMsg(err) });
    }
  })();
});

async function main(): Promise<void> {
  await loadSelectorOverrides();
  // Estado inicial siempre 'idle': que exista un perfil (sessionExists) no
  // garantiza sesión válida sin abrir el navegador. El campo `sessionExists`
  // del status ya informa de la presencia del perfil.
  setState('idle');
  // Latido del control-server (ver /ops/publisher).
  startHeartbeat('worker.control.heartbeat', logger);
  server.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT, headless: config.playwright.headless, auth: CONTROL_TOKEN ? 'enabled' : 'disabled' }, 'worker-publish control server started');
  });
}

const shutdown = async (): Promise<void> => {
  logger.info('shutting down control server');
  await cleanup();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

main().catch((err) => {
  logger.error({ err: errMsg(err) }, 'control server failed to start');
  process.exit(1);
});

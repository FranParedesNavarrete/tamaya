/**
 * Clasificación del estado real de WhatsApp Web.
 *
 * Motivación: `waitForAny(SELECTORS.appReady)` fallando durante 60s no dice
 * NADA útil. Los selectores de `appReady` (#pane-side, #side, "Chat list",
 * `header`) existen siempre que la sesión esté cargada — están verificados
 * contra dumps reales del DOM. Si fallan todos, el problema NO es el selector:
 * es que la página está en otro estado (QR, splash, navegador no soportado,
 * error de red…).
 *
 * Este módulo mira qué hay realmente en pantalla y devuelve un error accionable
 * ("la sesión está desvinculada, re-enlaza desde la UI") en vez de un timeout
 * anónimo que obliga a abrir el screenshot de debug a mano.
 */
import type { Page } from 'playwright';
import { SELECTORS } from './selectors.js';
import { diagnoseSelectors, waitForAny } from './dom-helpers.js';
import { logger } from '../logger.js';

export type AppState =
  | 'logged_in'
  | 'qr_login'
  | 'loading'
  | 'unsupported_browser'
  | 'error_page'
  | 'unknown';

export interface AppStateReport {
  state: AppState;
  url: string;
  title: string;
  /** Explicación legible + qué hacer. */
  detail: string;
}

/** Cuenta rápida sin lanzar. */
async function has(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count().catch(() => 0)) > 0;
}

/** Texto visible del body, recortado (para buscar frases de estado). */
async function bodyText(page: Page, max = 4000): Promise<string> {
  const txt = (await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '')) ?? '';
  return txt.slice(0, max);
}

/**
 * Determina en qué pantalla está WhatsApp Web. Nunca lanza: si no puede
 * inspeccionar la página devuelve 'unknown'.
 */
export async function describeAppState(page: Page): Promise<AppStateReport> {
  const url = page.url();
  const title = (await page.title().catch(() => '')) ?? '';

  // 1) ¿App cargada? Cualquier anchor de appReady presente (aunque esté oculto).
  for (const sel of SELECTORS.appReady) {
    if (await has(page, sel)) {
      return { state: 'logged_in', url, title, detail: `anchor presente: ${sel}` };
    }
  }

  const text = (await bodyText(page)).toLowerCase();

  // 2) Pantalla de login por QR / vinculación de dispositivo.
  const qrSelectors = [
    ...SELECTORS.loginQrCanvas,
    'canvas',
    'div[data-ref]',
    '[aria-label*="QR" i]',
  ];
  const qrFrases = [
    'steps to log in',
    'log into whatsapp',
    'link a device',
    'linked devices',
    'scan the qr',
    'escanea el código',
    'pasos para iniciar sesión',
    'vincular un dispositivo',
    'log in with phone number',
  ];
  const qrPorTexto = qrFrases.some((f) => text.includes(f));
  let qrPorDom = false;
  for (const sel of qrSelectors) {
    if (await has(page, sel)) { qrPorDom = true; break; }
  }
  if (qrPorTexto || qrPorDom) {
    return {
      state: 'qr_login',
      url,
      title,
      detail:
        'WhatsApp Web está pidiendo vincular el dispositivo (pantalla de QR): ' +
        'la sesión guardada en userDataDir ya no es válida. ' +
        'Vuelve a enlazar WhatsApp desde la UI (Ajustes → WhatsApp) y reintenta.',
    };
  }

  // 3) Navegador no soportado / hay que actualizar.
  const unsupportedFrases = [
    'update whatsapp',
    'unsupported browser',
    'browser is not supported',
    'actualiza whatsapp',
    'navegador no compatible',
    'navegador no es compatible',
  ];
  if (unsupportedFrases.some((f) => text.includes(f))) {
    return {
      state: 'unsupported_browser',
      url,
      title,
      detail:
        'WhatsApp Web dice que el navegador no está soportado o hay que actualizar. ' +
        'Actualiza Playwright y sus binarios (`npx playwright install chromium`) y reintenta.',
    };
  }

  // 4) Página de error de navegación (Chromium net::ERR_*) o about:blank.
  const errorFrases = ['err_', 'no se puede acceder a este sitio', "site can't be reached", 'this site can’t be reached'];
  if (url.startsWith('chrome-error://') || url === 'about:blank' || errorFrases.some((f) => text.includes(f))) {
    return {
      state: 'error_page',
      url,
      title,
      detail:
        'El navegador no llegó a cargar web.whatsapp.com (página de error o about:blank). ' +
        'Revisa la salida de red del servidor / DNS del contenedor.',
    };
  }

  // 5) Splash de arranque: WA cargado pero todavía sincronizando.
  const loadingFrases = ['loading', 'cargando', 'sincroniz', 'syncing', 'end-to-end encrypted'];
  const splashSel = [
    'progress',
    '[role="progressbar"]',
    '#app div[data-icon="intro-md-beta-logo-dark"]',
    '#app div[data-icon="intro-md-beta-logo-light"]',
  ];
  let splashPorDom = false;
  for (const sel of splashSel) {
    if (await has(page, sel)) { splashPorDom = true; break; }
  }
  if (splashPorDom || loadingFrases.some((f) => text.includes(f))) {
    return {
      state: 'loading',
      url,
      title,
      detail:
        'WhatsApp Web se quedó en la pantalla de carga/sincronización. ' +
        'Suele indicar un perfil (userDataDir) muy grande o corrupto, o que el ' +
        'móvil vinculado no está accesible. Si se repite, re-enlaza la sesión.',
    };
  }

  return {
    state: 'unknown',
    url,
    title,
    detail: `pantalla no reconocida. Primeros caracteres del body: ${text.slice(0, 300)}`,
  };
}

/**
 * Espera a que WhatsApp Web esté logueado y usable.
 *
 * Sustituye a `waitForAny(page, SELECTORS.appReady)` en los publishers: si no
 * llega a tiempo, clasifica la pantalla y lanza un error que dice QUÉ pasa y
 * QUÉ hacer, además del diagnóstico selector a selector.
 */
export async function waitForAppReady(
  page: Page,
  opts: { timeout?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 60_000;
  try {
    await waitForAny(page, SELECTORS.appReady, { timeout });
    return;
  } catch (err) {
    const report = await describeAppState(page);
    const diagnosis = await diagnoseSelectors(page, SELECTORS.appReady);
    logger.error(
      { appState: report.state, url: report.url, title: report.title, diagnosis },
      'WhatsApp Web no alcanzó estado logueado',
    );
    throw new Error(
      `WhatsApp Web no alcanzó estado logueado en ${timeout}ms ` +
        `[estado=${report.state}, url=${report.url}, título="${report.title}"]. ` +
        `${report.detail} | appReady: ${diagnosis} | causa original: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

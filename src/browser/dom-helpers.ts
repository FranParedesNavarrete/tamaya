/**
 * Helpers para lidiar con selectores volátiles de WhatsApp Web.
 *
 * Todas las búsquedas contra el DOM pasan por aquí. Ventajas:
 * - Probar varios selectores en orden (primero el más estable).
 * - Guardar screenshot + dump del DOM cuando algo falla.
 * - Logs claros de qué selector ha ganado (útil para el hotfix playbook).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { logger } from '../logger.js';

export interface WaitForAnyOptions {
  /** Timeout total. Default 30_000 ms. */
  timeout?: number;
  /** Estado a esperar. Default 'visible'. */
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

/**
 * Espera hasta que AL MENOS UNO de los selectores matchee el estado deseado,
 * y devuelve el Locator ganador (útil para clicks/queries posteriores).
 *
 * Loguea cuál ganó — valioso para mantener selectores.
 */
export async function waitForAny(
  page: Page,
  selectors: readonly string[],
  opts: WaitForAnyOptions = {},
): Promise<Locator> {
  const { timeout = 30_000, state = 'visible' } = opts;
  const tStart = Date.now();
  const locators = selectors.map((s) => page.locator(s).first());

  // Polling en paralelo — el primero que resuelva gana.
  const result = await Promise.race(
    locators.map(async (loc, idx) => {
      try {
        await loc.waitFor({ state, timeout });
        return { idx, loc };
      } catch {
        return null;
      }
    }),
  );

  if (result) {
    const elapsed = Date.now() - tStart;
    logger.debug(
      { selector: selectors[result.idx], elapsed, idx: result.idx },
      'waitForAny matched',
    );
    return result.loc;
  }

  // Ninguno visible — esperar hasta timeout total con el primero
  throw new Error(
    `waitForAny: no selector matched in ${timeout}ms. Tried: ${selectors.join(' | ')}`,
  );
}

/**
 * Dado un array de selectores y una función que genera el selector a partir
 * de un parámetro (p. ej. nombre de canal), prueba todos hasta encontrar uno.
 */
export async function waitForAnyDynamic(
  page: Page,
  selectors: string[],
  opts: WaitForAnyOptions = {},
): Promise<Locator> {
  return waitForAny(page, selectors, opts);
}

/**
 * Captura screenshot + HTML del DOM cuando algo falla. Guarda en `debug/`.
 */
export async function dumpDebugInfo(page: Page, tag: string): Promise<string> {
  const debugDir = 'debug';
  mkdirSync(debugDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(debugDir, `${ts}_${tag}`);

  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const html = await page.content();
    writeFileSync(`${base}.html`, html, 'utf-8');
    logger.warn({ screenshot: `${base}.png`, html: `${base}.html` }, 'debug dump saved');
  } catch (err) {
    logger.error({ err }, 'failed to write debug dump');
  }
  return base;
}

/**
 * Tipea texto carácter a carácter en un contenteditable enfocado.
 * Simula pulsaciones humanas con jitter ligero entre teclas.
 */
export async function humanType(
  page: Page,
  text: string,
  opts: { minDelayMs?: number; maxDelayMs?: number } = {},
): Promise<void> {
  const min = opts.minDelayMs ?? 30;
  const max = opts.maxDelayMs ?? 90;
  for (const ch of text) {
    await page.keyboard.type(ch);
    const jitter = Math.floor(min + Math.random() * (max - min));
    await page.waitForTimeout(jitter);
  }
}

/** Pausa con jitter humano. Útil antes de clicks "finales". */
export async function humanPause(
  page: Page,
  rangeMs: [number, number] = [400, 1200],
): Promise<void> {
  const [lo, hi] = rangeMs;
  const ms = lo + Math.floor(Math.random() * (hi - lo));
  await page.waitForTimeout(ms);
}

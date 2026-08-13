/**
 * Helpers para lidiar con selectores volátiles de WhatsApp Web.
 *
 * Todas las búsquedas contra el DOM pasan por aquí. Ventajas:
 * - Probar varios selectores en orden (primero el más estable).
 * - Guardar screenshot + dump del DOM cuando algo falla.
 * - Logs claros de qué selector ha ganado (útil para el hotfix playbook).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
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

  // Promise.any: gana el PRIMERO que cumple, y solo falla si fallan TODOS.
  //
  // Antes esto era un Promise.race sobre promesas que resolvían a `null` en
  // caso de fallo, así que el primer selector en fallar (p. ej. uno inválido
  // para el motor de Playwright, que rechaza al instante) ganaba la carrera y
  // abortaba la espera entera. El mensaje seguía diciendo "in 60000ms" porque
  // imprimía el timeout configurado, no el tiempo real ⇒ diagnóstico engañoso.
  try {
    const winner = await Promise.any(
      locators.map(async (loc, idx) => {
        await loc.waitFor({ state, timeout });
        return { idx, loc };
      }),
    );
    logger.debug(
      { selector: selectors[winner.idx], elapsedMs: Date.now() - tStart, idx: winner.idx },
      'waitForAny matched',
    );
    return winner.loc;
  } catch {
    const elapsedMs = Date.now() - tStart;
    const diagnosis = await diagnoseSelectors(page, selectors);
    throw new Error(
      `waitForAny: no selector matched (state=${state}) tras ${elapsedMs}ms ` +
        `(timeout ${timeout}ms). Estado de cada selector: ${diagnosis}`,
    );
  }
}

/**
 * Para cada selector dice si el elemento no existe, existe pero está oculto, o
 * si el selector es inválido. Distinguir "ausente" de "presente pero oculto" es
 * lo que decide si hay que cambiar el selector o si el problema es de estado de
 * la página (overlay encima, panel colapsado, sesión no cargada…).
 */
export async function diagnoseSelectors(
  page: Page,
  selectors: readonly string[],
): Promise<string> {
  const parts: string[] = [];
  for (const sel of selectors) {
    try {
      const count = await page.locator(sel).count();
      if (count === 0) {
        parts.push(`${sel} → ausente`);
        continue;
      }
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      parts.push(`${sel} → ${visible ? 'visible' : 'presente pero OCULTO'} (n=${count})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      parts.push(`${sel} → SELECTOR INVÁLIDO (${msg})`);
    }
  }
  return parts.join(' ; ');
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

/**
 * Escribe texto multilínea en un contenteditable enfocado (Lexical editor
 * de WhatsApp Web), preservando saltos de línea.
 *
 * Problema que resuelve: `locator.pressSequentially("A\nB", ...)` introduce
 * un Enter literal entre las líneas, y en WA Channels el Enter ENVÍA el
 * mensaje. El resultado es que el mensaje se parte en dos.
 *
 * Solución: split por `\n`, escribir cada línea con `pressSequentially` y
 * entre líneas pulsar `Shift+Enter` (que en Lexical inserta un salto de
 * línea sin disparar el send).
 *
 * Compatible con líneas vacías (`A\n\nB`) — entre cada `\n` se mete un
 * Shift+Enter, así que `A` + Shift+Enter + Shift+Enter + `B` = párrafos
 * separados con línea en blanco, exactamente como en la entrada original.
 */
export async function typeMultiline(
  _page: Page,
  locator: Locator,
  body: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const delay = opts.delayMs ?? 50;
  // Normalizar separadores de línea (Windows / Mac viejos) a `\n`.
  const lines = body.replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // Importante: locator.press en lugar de page.keyboard.press para que
      // el evento se entregue AL composer (re-foca antes). Con keyboard.press
      // global el foco puede haberse ido a otro sitio y el Shift+Enter no
      // tendría el efecto esperado dentro del Lexical editor.
      await locator.press('Shift+Enter');
    }
    if (lines[i].length > 0) {
      await locator.pressSequentially(lines[i], { delay });
    }
  }
}

/**
 * Reemplaza todo el texto de un contenteditable de WhatsApp de forma robusta.
 * Para textos largos con saltos de línea, la vía más estable es: limpiar
 * composer → copiar al clipboard → pegar. Si el clipboard falla, usamos el
 * fallback histórico con Shift+Enter.
 */
export async function replaceEditableText(
  page: Page,
  locator: Locator,
  body: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  await locator.click();
  await page.waitForTimeout(100);
  await clearEditable(page, locator);

  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://web.whatsapp.com',
    });
    await page.evaluate(async (text) => {
      await (globalThis as any).navigator.clipboard.writeText(text);
    }, body);
    await locator.click();
    await page.keyboard.press(platform() === 'darwin' ? 'Meta+V' : 'Control+V');
    await page.waitForTimeout(300);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'clipboard paste failed — falling back to multiline typing');
    await typeMultiline(page, locator, body, opts);
  }
}

/** Limpia un contenteditable evitando que un retry escriba encima del intento anterior. */
export async function clearEditable(page: Page, locator: Locator): Promise<void> {
  await locator.click();
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press(platform() === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
  }
}

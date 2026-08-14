/**
 * Cierre de diálogos modales de WhatsApp Web.
 *
 * WA Web abre modales globales sin avisar: "What's new on WhatsApp Web",
 * onboarding de canales, avisos de "descarga la app", permisos de notificaciones…
 * Todos llevan `aria-modal="true"` y un backdrop a pantalla completa, así que
 * mientras estén abiertos NINGÚN click funciona: Playwright falla con
 * "element intercepts pointer events" o con un Timeout al clicar, aunque el
 * selector de destino sea perfecto. Es decir: el síntoma parece "selector roto"
 * pero la causa es un modal encima.
 *
 * Este módulo los cierra de forma best-effort (nunca lanza) y devuelve cuántos
 * ha cerrado, para poder verlo en los logs.
 */
import type { Locator, Page } from 'playwright';

import { logger } from '../logger.js';
import { SELECTORS } from './selectors.js';

/** Texto del título del diálogo, para logs. Best-effort. */
async function dialogTitle(dialog: Locator): Promise<string> {
  const title = dialog.locator('h1, h2, [data-testid="popup-title"]').first();
  const raw = await title.innerText({ timeout: 500 }).catch(() => '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Primer diálogo bloqueante visible, o null si no hay ninguno. */
async function findVisibleDialog(page: Page): Promise<{ dialog: Locator; selector: string } | null> {
  for (const selector of SELECTORS.blockingDialog) {
    const dialog = page.locator(selector).first();
    const visible = await dialog.isVisible().catch(() => false);
    if (visible) return { dialog, selector };
  }
  return null;
}

/**
 * Cierra los diálogos modales que estén abiertos.
 *
 * Estrategia por diálogo: botón de cierre scopeado DENTRO del diálogo (el aspa
 * primero, que no acepta nada; luego "Continue"/"Entendido"…). Si no hay ningún
 * botón visible, `Escape`. Se repite hasta `rounds` veces porque WA puede
 * encolar varios modales seguidos.
 *
 * @returns número de diálogos cerrados.
 */
export async function dismissBlockingDialogs(
  page: Page,
  opts: { rounds?: number } = {},
): Promise<number> {
  const rounds = opts.rounds ?? 3;
  let dismissed = 0;

  for (let i = 0; i < rounds; i++) {
    const found = await findVisibleDialog(page);
    if (!found) return dismissed;

    const title = await dialogTitle(found.dialog);
    let clicked: string | null = null;

    for (const dismissSelector of SELECTORS.blockingDialogDismiss) {
      const button = found.dialog.locator(dismissSelector).first();
      if (!(await button.isVisible().catch(() => false))) continue;
      const ok = await button
        .click({ timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        clicked = dismissSelector;
        break;
      }
    }

    if (clicked === null) {
      await page.keyboard.press('Escape').catch(() => undefined);
    }

    logger.info(
      { title, matchedBy: found.selector, dismissedWith: clicked ?? 'Escape', round: i + 1 },
      'blocking dialog dismissed',
    );
    dismissed += 1;
    await page.waitForTimeout(500);
  }

  // Si tras todas las rondas sigue habiendo modal, no abortamos: el paso
  // siguiente fallará con su propio mensaje y el dump de debug lo mostrará.
  const stillOpen = await findVisibleDialog(page);
  if (stillOpen) {
    logger.warn(
      { matchedBy: stillOpen.selector, title: await dialogTitle(stillOpen.dialog), rounds },
      'blocking dialog still open after dismiss attempts',
    );
  }
  return dismissed;
}

/** Firma de un click bloqueado por un overlay, tal y como lo reporta Playwright. */
function looksIntercepted(message: string): boolean {
  return /intercepts pointer events|Timeout .* exceeded/i.test(message);
}

/**
 * Click que sobrevive a un modal que aparece en medio.
 *
 * Playwright ya reintenta solo, pero reintentar no sirve de nada si lo que
 * estorba es un modal: se agota el timeout completo repitiendo el mismo click
 * contra el backdrop (se ven los "58 × retrying click action" en los logs) y el
 * error final culpa al selector — que estaba bien.
 *
 * Aquí, si el click falla con pinta de intercepción, cerramos los diálogos y
 * reintentamos una vez. Cualquier otro error se propaga tal cual.
 *
 * @param what descripción corta para los logs ("Channels tab", "channel row"…).
 */
export async function clickWithDialogGuard(
  page: Page,
  target: Locator,
  what: string,
  opts: { timeout?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 8_000;
  try {
    await target.click({ timeout });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!looksIntercepted(message)) throw err;

    logger.warn({ what, err: message.split('\n')[0] }, 'click blocked — dismissing dialogs');
    const dismissed = await dismissBlockingDialogs(page);
    if (dismissed === 0) {
      // Nada que cerrar ⇒ el bloqueo no era un modal nuestro: no lo tapamos.
      throw err;
    }
    await target.click({ timeout });
    logger.info({ what, dismissed }, 'click succeeded after dismissing dialogs');
  }
}

/**
 * Publicación de texto plano en un canal.
 *
 * ESTADO: skeleton. Implementación real se completa en Fase 2 del PoC Backlog.
 * Los selectores viven en src/browser/selectors.ts.
 */
import type { Page } from 'playwright';
import { launchBrowser, openContext, saveSession, sessionExists } from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import { logger } from '../logger.js';

export interface PublishTextInput {
  channelIdentifier: {
    inviteLink?: string;
    whatsappId?: string;
    name: string;
  };
  body: string;
}

export interface PublishResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

export async function publishText(input: PublishTextInput): Promise<PublishResult> {
  if (!sessionExists()) {
    return {
      success: false,
      durationMs: 0,
      error: 'No session found — run `npm run login` first',
    };
  }

  const started = Date.now();
  const browser = await launchBrowser();
  try {
    const context = await openContext(browser);
    const page = await context.newPage();
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SELECTORS.appReadyMarker, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);
    await typeAndSend(page, input.body);

    // Guardar sesión por si hay cambios (cookies, tokens rotados).
    await saveSession(context);

    return { success: true, durationMs: Date.now() - started };
  } catch (err) {
    logger.error({ err }, 'publishText failed');
    return {
      success: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser.close();
  }
}

async function navigateToChannel(
  _page: Page,
  _channel: PublishTextInput['channelIdentifier'],
): Promise<void> {
  // TODO (PoC Fase 2 T2.1-T2.2):
  // 1. Click en la pestaña de Actualizaciones (selectors.updatesTab)
  // 2. Buscar el canal por invite link (preferido) o por nombre exacto
  // 3. Click y esperar a que el hilo cargue
  throw new Error('navigateToChannel: not implemented — see PoC-BACKLOG Fase 2');
}

async function typeAndSend(_page: Page, _body: string): Promise<void> {
  // TODO (PoC Fase 2 T2.3-T2.4):
  // 1. Focus en composer (selectors.messageComposer) — es contenteditable
  // 2. Tipear body con page.keyboard.type (NO fill — es contenteditable)
  // 3. Click en selectors.sendButton
  // 4. Verificación básica: el mensaje aparece en el hilo (selectors.lastMessageBubble)
  throw new Error('typeAndSend: not implemented — see PoC-BACKLOG Fase 2');
}

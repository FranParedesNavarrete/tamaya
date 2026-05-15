/**
 * Publicación de texto plano en un canal de WhatsApp.
 *
 * Flujo:
 *  1. Cargar sesión + abrir WA Web
 *  2. Navegar al canal:
 *     - Preferencia A: invite link (directa, más robusta)
 *     - Preferencia B: pestaña "Canales" + buscar por nombre
 *  3. Tipear el texto en el composer (contenteditable)
 *  4. Enviar (botón o Enter)
 *  5. Verificación básica: el mensaje aparece en el hilo con texto coincidente
 *
 * Registro en SQLite del intento completo (estado, duración, error).
 */
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import {
  launchPersistentContextForTenant,
  sessionExists,
} from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import {
  dumpDebugInfo,
  humanPause,
  humanType,
  typeMultiline,
  waitForAny,
  waitForAnyDynamic,
} from '../browser/dom-helpers.js';
import { audit, db } from '../db/client.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

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
  messageId: string;
  debugDump?: string;
  error?: string;
}

export async function publishText(input: PublishTextInput): Promise<PublishResult> {
  if (!sessionExists()) {
    return {
      success: false,
      durationMs: 0,
      messageId: '',
      error: 'No session found — run `npm run login` first',
    };
  }

  const started = Date.now();
  const messageId = randomUUID();

  // Registrar en DB antes de empezar — si muere el proceso, queda traza.
  const channelDbId = ensureChannelRow(input.channelIdentifier);
  db.prepare(
    `INSERT INTO messages (id, tenant_id, channel_id, body, status)
     VALUES (?, ?, ?, ?, 'in_progress')`,
  ).run(messageId, config.tenantId, channelDbId, input.body);
  audit('user', 'publish_text_start', messageId, {
    channel: input.channelIdentifier.name,
  });

  const context = await launchPersistentContextForTenant();
  let debugDump: string | undefined;

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    logger.info('opening WhatsApp Web');
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

    logger.info('waiting for app to be ready');
    await waitForAny(page, SELECTORS.appReady, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);
    await typeAndSend(page, input.body);

    // Verificación básica: el texto aparece en el hilo
    const verified = await verifyLastTextMessage(page, input.body);
    if (!verified) {
      throw new Error(
        'post-send verification failed — message sent but not found in thread',
      );
    }

    const durationMs = Date.now() - started;
    db.prepare(
      `UPDATE messages SET status='sent', sent_at=datetime('now'), duration_ms=? WHERE id=?`,
    ).run(durationMs, messageId);
    audit('system', 'publish_text_success', messageId, { durationMs });

    return { success: true, durationMs, messageId };
  } catch (err) {
    const page = context.pages()[0];
    if (page) {
      try {
        debugDump = await dumpDebugInfo(page, 'publish-text-fail');
      } catch {
        /* already logged */
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - started;
    db.prepare(
      `UPDATE messages SET status='failed', last_error=?, duration_ms=?, attempted_count=attempted_count+1 WHERE id=?`,
    ).run(errMsg, durationMs, messageId);
    audit('system', 'publish_text_failed', messageId, { error: errMsg });
    logger.error({ err }, 'publishText failed');
    return { success: false, durationMs, messageId, error: errMsg, debugDump };
  } finally {
    await context.close();
  }
}

/**
 * Inserta/upserta el canal en la DB local y devuelve su id.
 * (En el PoC el "tenant" es único y el canal se identifica por nombre.)
 */
function ensureChannelRow(
  ch: PublishTextInput['channelIdentifier'],
): string {
  const existing = db
    .prepare(
      `SELECT id FROM channels WHERE tenant_id = ? AND name = ? LIMIT 1`,
    )
    .get(config.tenantId, ch.name) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO channels (id, tenant_id, name, invite_link, whatsapp_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, config.tenantId, ch.name, ch.inviteLink ?? null, ch.whatsappId ?? null);
  return id;
}

// ---------------------------------------------------------------------------
// Navegación al canal
// ---------------------------------------------------------------------------

export async function navigateToChannel(
  page: Page,
  ch: { inviteLink?: string; whatsappId?: string; name: string },
): Promise<void> {
  // Estrategia A: invite link directo (si lo tenemos)
  if (ch.inviteLink) {
    logger.info({ link: ch.inviteLink }, 'navigating via invite link');
    try {
      await navigateByInviteLink(page, ch.inviteLink);
      await confirmChannelOpen(page, ch.name);
      await dismissOnboardingOverlays(page);
      return;
    } catch (err) {
      logger.warn({ err }, 'invite link navigation failed, falling back to name search');
    }
  }

  // Estrategia B: pestaña Canales + buscar por nombre
  logger.info({ name: ch.name }, 'navigating via Channels tab + name');
  await openChannelsTab(page);
  await selectChannelByName(page, ch.name);
  await confirmChannelOpen(page, ch.name);
  await dismissOnboardingOverlays(page);
}

async function navigateByInviteLink(page: Page, inviteLink: string): Promise<void> {
  // Los invite links tienen forma https://whatsapp.com/channel/<id>
  // WA Web los maneja redirigiendo al canal si estamos logueados.
  const m = inviteLink.match(/channel\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`invalid invite link: ${inviteLink}`);

  // Probamos la URL web-nativa primero; si no, la de click-through.
  await page.goto(inviteLink, { waitUntil: 'domcontentloaded' });
  // Si WA abre un modal pidiendo seguir el canal, el siguiente paso
  // (`confirmChannelOpen`) lo detectará como fallo y el usuario lo verá
  // en el screenshot de debug.
}

async function openChannelsTab(page: Page): Promise<void> {
  try {
    const tab = await waitForAny(page, SELECTORS.channelsTab, { timeout: 15_000 });
    await humanPause(page);
    await tab.click();
    // Pequeña espera para que el panel lateral cambie.
    await page.waitForTimeout(800);
  } catch (err) {
    throw new Error(
      `could not open Channels tab (selectors may be outdated): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function selectChannelByName(page: Page, name: string): Promise<void> {
  const selectors = SELECTORS.channelRowByName(name);

  // Intentar directamente primero
  try {
    const row = await waitForAnyDynamic(page, selectors, { timeout: 8_000 });
    await humanPause(page);
    await row.click();
    return;
  } catch {
    // No está a la vista — probar con el search de canales
  }

  // Fallback: usar el buscador de canales si existe
  try {
    const search = await waitForAny(page, SELECTORS.channelsSearchInput, {
      timeout: 5_000,
    });
    await search.click();
    await humanType(page, name, { minDelayMs: 50, maxDelayMs: 120 });
    await page.waitForTimeout(600);

    const row = await waitForAnyDynamic(page, selectors, { timeout: 8_000 });
    await row.click();
    return;
  } catch (err) {
    throw new Error(
      `channel "${name}" not found in channels list: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function confirmChannelOpen(page: Page, expectedName: string): Promise<void> {
  // Estrategia primaria: esperar el composer específico de este canal.
  // aria-label dinámico = "Escribir un mensaje para <nombre>" ⇒ prueba de que
  // (a) el canal está abierto y (b) es el correcto, en un solo selector.
  const specificComposerSelectors = SELECTORS.messageComposerForChannel(expectedName);

  try {
    await waitForAnyDynamic(page, specificComposerSelectors, { timeout: 15_000 });
    logger.info({ channel: expectedName }, 'channel open — specific composer matched');
  } catch {
    // Fallback: composer genérico (cualquier canal).
    // Esto pasa si el idioma de la UI es otro o WA cambió el aria-label.
    logger.warn(
      { channel: expectedName },
      'specific composer not found, falling back to generic composer',
    );
    await waitForAny(page, SELECTORS.messageComposer, { timeout: 10_000 });
    logger.info('generic composer found — assuming channel is open');
  }

  // Bonus (no bloqueante): leer contador de seguidores para telemetría.
  try {
    const counter = await waitForAny(page, SELECTORS.openChannelSubscriberCount, {
      timeout: 2_000,
    });
    const text = await counter.getAttribute('aria-label');
    logger.info({ subscribers: text }, 'channel subscriber count read');
  } catch {
    // No pasa nada si no lo encuentra — es diagnóstico, no decisión.
  }
}

/**
 * WA muestra paneles de onboarding en canales nuevos ("Aumenta seguidores",
 * "Comparte enlace"). Si existe, pueden tapar el composer. Best-effort close.
 */
async function dismissOnboardingOverlays(page: Page): Promise<void> {
  // Buscamos botones "Cerrar" que estén cerca de textos de onboarding típicos.
  // Damos margen corto — si no hay overlay, no queremos bloquear el flujo.
  try {
    const closeButton = await waitForAny(page, SELECTORS.onboardingCloseButton, {
      timeout: 1_500,
    });
    // Solo cerrar si es visible (evitar cerrar botones de otros diálogos por error)
    const isVisible = await closeButton.isVisible();
    if (isVisible) {
      await closeButton.click();
      logger.info('onboarding overlay dismissed');
      await page.waitForTimeout(400);
    }
  } catch {
    // No hay overlay — seguimos. Esto es el camino normal.
  }
}

// ---------------------------------------------------------------------------
// Composición y envío
// ---------------------------------------------------------------------------

async function typeAndSend(page: Page, body: string): Promise<void> {
  const composer = await waitForAny(page, SELECTORS.messageComposer, {
    timeout: 10_000,
  });

  // 1. Focus explícito en el composer
  await composer.click();
  await humanPause(page, [200, 500]);

  // 2. Tipear preservando saltos de línea con Shift+Enter (un `\n` literal
  //    enviaría el mensaje a medias en WA Channels).
  await typeMultiline(page, composer, body, { delayMs: 50 });

  // 3. Verificar que el texto llegó al composer. Normalizamos whitespace
  //    porque Lexical puede serializar saltos como `\n`, ` `, etc.
  const typed = (await composer.textContent()) ?? '';
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (normalize(typed) !== normalize(body)) {
    throw new Error(
      `composer text mismatch after typing: expected="${body}" got="${typed}"`,
    );
  }
  logger.debug({ typed }, 'composer text verified');

  // 4. Esperar a que el send button aparezca (desaparece el mic-outlined)
  //    Esto es la confirmación de que WA reconoció el texto.
  await humanPause(page, [600, 1400]);

  try {
    const sendBtn = await waitForAny(page, SELECTORS.sendButton, { timeout: 5_000 });
    await sendBtn.click();
    logger.debug('sent via send button');
    return;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'send button not found — falling back to Enter',
    );
  }

  // 5. Fallback: Enter (en canales WA Web, Enter envía sin Shift)
  await composer.focus();
  await page.keyboard.press('Enter');
  logger.debug('sent via Enter key fallback');
}

// ---------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------

async function verifyLastTextMessage(page: Page, expectedBody: string): Promise<boolean> {
  try {
    // Esperar a que aparezca un nuevo bubble en el hilo.
    await waitForAny(page, SELECTORS.lastMessageBubble, { timeout: 15_000 });

    // Dar margen a que el texto renderice
    await page.waitForTimeout(500);

    // Buscar el texto del último mensaje. Probamos varios selectores de texto.
    for (const textSel of SELECTORS.messageText) {
      const nodes = page.locator(`${SELECTORS.lastMessageBubble.join(', ')}`).last().locator(textSel);
      try {
        const content = await nodes.first().innerText({ timeout: 2_000 });
        if (content.trim() === expectedBody.trim()) {
          logger.info({ matchedBy: textSel }, 'post-send verification OK');
          return true;
        }
        logger.debug({ got: content, expected: expectedBody }, 'text mismatch, trying next selector');
      } catch {
        /* probar siguiente */
      }
    }

    logger.warn('post-send verification: text not matched');
    return false;
  } catch (err) {
    logger.warn({ err }, 'post-send verification: no last message bubble found');
    return false;
  }
}

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
  replaceEditableText,
  clearEditable,
  waitForAny,
  waitForAnyDynamic,
} from '../browser/dom-helpers.js';
import { audit, db } from '../db/client.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { findLastThreadTexts, findPageVisibleText, normalizeText, textMatchesAny } from './verify.js';
import type { PublishVerificationMeta } from '@tamaya/shared-types';

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
  verificationMeta?: PublishVerificationMeta;
  postSendMaybeDelivered?: boolean;
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
  let sendClicked = false;

  const expected: PublishVerificationMeta['expected'] = {
    hasText: true,
    textLength: input.body.length,
    hasMedia: false,
  };

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    logger.info('opening WhatsApp Web');
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

    logger.info('waiting for app to be ready');
    await waitForAny(page, SELECTORS.appReady, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);

    // ---- PUNTO DE NO RETORNO: typeAndSend pulsa Send. ----
    await typeAndSend(page, input.body);
    sendClicked = true;

    // Verificación de contenido: el texto aparece en el hilo (tolerante).
    const texts = await findLastThreadTexts(page, 5);
    const pageText = await findPageVisibleText(page);
    const textMatched = textMatchesAny(input.body, [...texts, pageText]);
    const durationMs = Date.now() - started;
    const observed: PublishVerificationMeta['observed'] = {
      previewClosed: true,           // no hay preview en texto plano
      sendClicked: true,
      indicatorAppeared: false,
      threadItemAppeared: texts.length > 0,
      textMatched,
      mediaDetected: 'unknown',
      uploadPendingCleared: 'unknown',
    };

    if (textMatched) {
      const verificationMeta: PublishVerificationMeta = {
        expected, observed, result: 'verified', checkedAt: new Date().toISOString(),
      };
      db.prepare(
        `UPDATE messages SET status='sent', sent_at=datetime('now'), duration_ms=? WHERE id=?`,
      ).run(durationMs, messageId);
      audit('system', 'publish_text_success', messageId, { durationMs });
      return { success: true, durationMs, messageId, verificationMeta };
    }

    // Enviado pero no confirmado → ambiguo, NO reintentar (posible duplicado).
    const page0 = context.pages()[0];
    if (page0) {
      try { debugDump = await dumpDebugInfo(page0, 'publish-text-verify'); } catch { /* logged */ }
    }
    const verificationMeta: PublishVerificationMeta = {
      expected, observed, result: 'ambiguous_after_send',
      reason: 'texto no confirmado en el hilo tras enviar', checkedAt: new Date().toISOString(),
    };
    db.prepare(
      `UPDATE messages SET status='failed', last_error=?, duration_ms=?, attempted_count=attempted_count+1 WHERE id=?`,
    ).run('post-send verification not confirmed', durationMs, messageId);
    logger.warn({ observed }, 'publishText post-send verification not confirmed');
    return {
      success: false, durationMs, messageId,
      error: 'post-send verification not confirmed', debugDump,
      verificationMeta, postSendMaybeDelivered: true,
    };
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
    logger.error({ err, sendClicked }, 'publishText failed');
    const verificationMeta: PublishVerificationMeta | undefined = sendClicked
      ? {
          expected,
          observed: {
            previewClosed: true, sendClicked: true, indicatorAppeared: false,
            threadItemAppeared: false, textMatched: 'unknown', mediaDetected: 'unknown',
            uploadPendingCleared: 'unknown',
          },
          result: 'ambiguous_after_send', reason: errMsg, checkedAt: new Date().toISOString(),
        }
      : undefined;
    return {
      success: false, durationMs, messageId, error: errMsg, debugDump,
      verificationMeta, postSendMaybeDelivered: sendClicked,
    };
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
  await dismissBlockingDialogs(page);
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
    try {
      await tab.click({ timeout: 8_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/intercepts pointer events|Timeout/i.test(msg)) throw err;
      logger.warn({ err: msg }, 'Channels tab click blocked — trying to dismiss dialog');
      await dismissBlockingDialogs(page);
      await tab.click({ timeout: 8_000 });
    }
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

/**
 * WA Web puede mostrar diálogos globales al iniciar sesión / entrar a Channels
 * (novedades, onboarding, permisos, "descarga la app", etc.). Si están abiertos
 * interceptan el click sobre la pestaña Channels aunque el selector sea correcto.
 * Cierre best-effort y conservador: primero botones Close/Cerrar visibles dentro
 * de role=dialog; si no, Escape. No falla si no hay nada.
 */
async function dismissBlockingDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator('div[role="dialog"][aria-modal="true"], div[role="dialog"]').filter({ hasNotText: /^$/ }).first();
    const visible = await dialog.isVisible({ timeout: 700 }).catch(() => false);
    if (!visible) return;

    const close = dialog.locator([
      'button[aria-label="Cerrar"]',
      'button[aria-label="Close"]',
      'div[role="button"][aria-label="Cerrar"]',
      'div[role="button"][aria-label="Close"]',
      'span[data-icon="x"]',
      'span[data-icon="x-alt"]',
    ].join(',')).first();

    if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
      await close.click({ timeout: 2_000 }).catch(() => undefined);
    } else {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await page.waitForTimeout(500);
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

  // 2. Pegar/reemplazar el texto completo. Esto es más estable que teclear
  //    copies largos con saltos de línea y evita escribir encima de un retry.
  await replaceEditableText(page, composer, body, { delayMs: 50 });

  // 3. Verificar que el texto llegó al composer con comparación tolerante:
  //    WA/Lexical puede convertir saltos, listas `*` en bullets `•` y espacios.
  const typed = (await composer.textContent()) ?? '';
  if (!composerTextEquivalent(typed, body)) {
    await clearEditable(page, composer).catch(() => undefined);
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
function composerTextEquivalent(actual: string, expected: string): boolean {
  const compact = (s: string) => normalizeText(s)
    .replace(/•/g, '*')
    .replace(/\s+/g, '')
    .trim();
  return compact(actual) === compact(expected);
}

// La verificación post-envío ahora vive en ./verify.ts (findLastThreadTexts +
// textMatchesAny), compartida con publishMedia.

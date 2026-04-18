/**
 * Publicación de media (imagen, vídeo, audio, documento) en un canal.
 *
 * Flujo:
 *  1. Abrir contexto persistente + WA Web
 *  2. Navegar al canal (reutiliza navigateToChannel de publish-text)
 *  3. Adjuntar media (setInputFiles tras click en "Adjuntar")
 *  4. Esperar al preview
 *  5. Escribir caption si hay
 *  6. Enviar desde el dialog del preview
 */
import type { Page } from 'playwright';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  launchPersistentContextForTenant,
  sessionExists,
} from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import {
  dumpDebugInfo,
  humanPause,
  waitForAny,
} from '../browser/dom-helpers.js';
import { logger } from '../logger.js';
import { navigateToChannel } from './publish-text.js';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface PublishMediaInput {
  channelIdentifier: {
    inviteLink?: string;
    whatsappId?: string;
    name: string;
  };
  body?: string;
  mediaPath: string;
  mediaKind: MediaKind;
}

export interface PublishResult {
  success: boolean;
  durationMs: number;
  mediaSha256?: string;
  error?: string;
  debugDump?: string;
}

export async function publishMedia(input: PublishMediaInput): Promise<PublishResult> {
  if (!sessionExists()) {
    return {
      success: false,
      durationMs: 0,
      error: 'No session found — run `npm run login` first',
    };
  }

  const started = Date.now();
  const mediaSha256 = await sha256OfFile(input.mediaPath);
  const context = await launchPersistentContextForTenant();
  let debugDump: string | undefined;

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
    await waitForAny(page, SELECTORS.appReady, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);

    await attachMedia(page, input.mediaPath, input.mediaKind);
    await waitForMediaPreview(page, input.mediaKind);
    await assertNotStickerPreview(page);

    // Escribimos el caption YA (mientras el vídeo sigue cargando). Así el
    // texto está presente en el composer antes de que WA termine de
    // procesar el media — si escribimos después, WA puede re-renderizar el
    // preview al completar el load y perder el texto.
    if (input.body) await addCaption(page, input.body);

    // Para vídeo, esperamos a que esté listo ANTES de clicar Send.
    if (input.mediaKind === 'video') await waitForVideoReady(page);

    await sendFromPreview(page);

    // Esperar a que el upload termine: el preview debe cerrarse Y la burbuja
    // del mensaje debe aparecer en el hilo con el tick (msg-check / msg-dblcheck
    // / msg-time). Si cerramos el contexto antes, cancelamos el upload.
    await waitForUploadComplete(page, input.mediaPath, input.mediaKind);

    return { success: true, durationMs: Date.now() - started, mediaSha256 };
  } catch (err) {
    const page = context.pages()[0];
    if (page) {
      try {
        debugDump = await dumpDebugInfo(page, 'publish-media-fail');
      } catch {
        /* ya logueado */
      }
    }
    logger.error({ err }, 'publishMedia failed');
    return {
      success: false,
      durationMs: Date.now() - started,
      mediaSha256,
      error: err instanceof Error ? err.message : String(err),
      debugDump,
    };
  } finally {
    await context.close();
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

export async function fileMeta(path: string): Promise<{
  size: number;
  sha256: string;
}> {
  const [s, sha] = await Promise.all([stat(path), sha256OfFile(path)]);
  return { size: s.size, sha256: sha };
}

/**
 * Adjunta un archivo.
 *
 * Flujo (WA Channels):
 *  1. Click en "+" (attach) → abre menú con botones role="menuitem"
 *  2. Click en "Photos & videos" → dispara el filechooser nativo
 *  3. Interceptamos el filechooser y hacemos setFiles(path)
 *
 * Este flujo evita el BUG de elegir el input equivocado (el de sticker
 * era `input[accept="image/*"]` y enviaba la imagen como pegatina).
 *
 * Fallback: si el filechooser no se dispara (cambio del DOM), intentamos
 * `setInputFiles` en el input multi-archivo genérico.
 */
async function attachMedia(page: Page, path: string, kind: MediaKind): Promise<void> {
  const attachBtn = await waitForAny(page, SELECTORS.attachButton, {
    timeout: 10_000,
  });
  await humanPause(page, [300, 600]);
  await attachBtn.click();
  await humanPause(page, [400, 800]);

  // Ruta primaria: click en "Photos & videos" e intercepta el filechooser.
  try {
    const menuItem = await waitForAny(page, SELECTORS.attachMenuPhotosVideos, {
      timeout: 4_000,
    });
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5_000 }),
      menuItem.click(),
    ]);
    await fileChooser.setFiles(path);
    logger.info({ path }, 'media attached via Photos & videos filechooser');
    return;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Photos & videos filechooser flow failed, falling back to direct input',
    );
  }

  // Fallback: setInputFiles sobre el input genérico (evitando el de sticker).
  const inputSelectors =
    kind === 'document' || kind === 'audio'
      ? [...SELECTORS.fileInputDocument, ...SELECTORS.fileInputImageVideo]
      : [...SELECTORS.fileInputImageVideo, ...SELECTORS.fileInputDocument];

  for (const sel of inputSelectors) {
    const input = page.locator(sel).first();
    const count = await input.count().catch(() => 0);
    if (count === 0) continue;
    try {
      await input.setInputFiles(path);
      logger.info({ selector: sel, path }, 'media attached (fallback input)');
      return;
    } catch (err) {
      logger.debug({ selector: sel, err }, 'setInputFiles failed, trying next');
    }
  }
  throw new Error(`no compatible file input found for media kind=${kind}`);
}

/**
 * Espera a que el preview del media APAREZCA (sin esperar a que el media
 * esté completamente cargado). Para vídeo esto puede tardar porque WA debe
 * generar el thumbnail inicial. Pero tras aparecer, el caption ya puede
 * escribirse aunque el vídeo siga cargando.
 */
async function waitForMediaPreview(page: Page, kind: MediaKind): Promise<void> {
  const timeout =
    kind === 'video' ? 120_000 : kind === 'audio' ? 60_000 : 25_000;
  logger.info({ kind, timeout }, 'waiting for media preview');
  await waitForAny(page, SELECTORS.mediaPreviewReady, { timeout });
  await humanPause(page, [500, 900]);
  logger.info('media preview ready');
}

/**
 * Espera a que el vídeo esté listo para enviar (metadata cargada y duración
 * conocida). Se llama ANTES de `sendFromPreview` y DESPUÉS de escribir el
 * caption — así el caption ya está persistido en el DOM cuando WA termina
 * de procesar el vídeo.
 */
async function waitForVideoReady(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      `(() => {
        const v = document.querySelector('video[src^="blob:"]');
        return !!v && v.readyState >= 1 && !isNaN(v.duration);
      })()`,
      undefined,
      { timeout: 60_000 },
    );
    logger.info('video metadata loaded');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'video metadata not confirmed — continuing anyway',
    );
  }
}

/**
 * Escribe el caption dentro del preview. En WA Channels el input es
 * `div[contenteditable="true"][aria-label="Type an update"]`.
 */
async function addCaption(page: Page, body: string): Promise<void> {
  const caption = await waitForAny(page, SELECTORS.captionInputOnPreview, {
    timeout: 8_000,
  });
  await caption.click();
  await humanPause(page, [200, 400]);
  await caption.pressSequentially(body, { delay: 50 });
  logger.debug({ body }, 'caption typed on preview');
  await humanPause(page, [300, 600]);
}

/**
 * Si el preview muestra la UI de Sticker en vez de Photo/Video, hemos caído
 * en el input equivocado. Falla ruidosamente para que el retry no envíe basura.
 *
 * Heurística: en modo sticker, el preview muestra "Add outline"/"Añadir contorno"
 * o la barra inferior de sticker tools en vez del composer "Type an update".
 * Si el composer de update NO está presente y en cambio hay un panel de edición
 * de sticker, lanzamos error.
 */
async function assertNotStickerPreview(page: Page): Promise<void> {
  // Si hay caption input "Type an update", es preview normal.
  const captionCount = await page
    .locator(SELECTORS.captionInputOnPreview.join(', '))
    .first()
    .count()
    .catch(() => 0);
  if (captionCount > 0) return;

  // Sin caption input y con indicadores de sticker editor → sticker mode.
  const stickerModeSelectors = [
    'button[aria-label="Add outline"]',
    'button[aria-label="Añadir contorno"]',
    'div[role="dialog"][aria-label*="sticker" i]',
    'div[role="dialog"][aria-label*="pegatina" i]',
  ];
  for (const sel of stickerModeSelectors) {
    const cnt = await page.locator(sel).count().catch(() => 0);
    if (cnt > 0) {
      throw new Error(
        'media attached as sticker, not as photo/video — wrong file input selected',
      );
    }
  }
}

/**
 * Envía desde el preview de media.
 *
 * En WA Channels el preview NO usa `role="dialog"` — es un overlay plano.
 * El botón de enviar es un `<div role="button" aria-label="Send">` con un
 * `<span data-icon="wds-ic-send-filled">` dentro. Probamos los selectores
 * robustos en orden y hacemos scroll al span si encontramos solo el icono.
 */
async function sendFromPreview(page: Page): Promise<void> {
  await humanPause(page, [600, 1200]);

  // 1) Selectores priorizados con aria-label (elemento clicable).
  const primary = [
    'div[role="button"][aria-label="Send"]',
    'div[role="button"][aria-label="Enviar"]',
    'button[aria-label="Send"]',
    'button[aria-label="Enviar"]',
  ];
  for (const sel of primary) {
    const loc = page.locator(sel).first();
    const cnt = await loc.count().catch(() => 0);
    if (cnt === 0) continue;
    try {
      await loc.click({ timeout: 4_000 });
      logger.info({ selector: sel }, 'media sent');
      return;
    } catch (err) {
      logger.debug({ selector: sel, err }, 'click failed, trying next');
    }
  }

  // 2) Fallback: encontrar el icono y clicar su ancestro clicable.
  const iconSelectors = [
    'span[data-icon="wds-ic-send-filled"]',
    'span[data-icon="send"]',
  ];
  for (const sel of iconSelectors) {
    const icon = page.locator(sel).first();
    const cnt = await icon.count().catch(() => 0);
    if (cnt === 0) continue;
    try {
      const clickable = icon.locator(
        'xpath=ancestor-or-self::*[@role="button" or self::button][1]',
      ).first();
      const clickableCnt = await clickable.count().catch(() => 0);
      if (clickableCnt > 0) {
        await clickable.click({ timeout: 4_000 });
      } else {
        await icon.click({ timeout: 4_000 });
      }
      logger.info({ selector: sel }, 'media sent (icon fallback)');
      return;
    } catch (err) {
      logger.debug({ selector: sel, err }, 'icon click failed, trying next');
    }
  }

  // 3) Último recurso: selector genérico del config.
  const send = await waitForAny(page, SELECTORS.sendButton, { timeout: 5_000 });
  await send.click();
  logger.info('media sent (generic send button)');
}

/**
 * Espera a que el upload del media termine antes de cerrar el navegador.
 *
 * WA Web hace el upload tras clicar Send; si cerramos el contexto demasiado
 * pronto, el request se cancela y el mensaje no llega nunca.
 *
 * Criterio de éxito:
 *  1. El preview overlay se cierra (img[alt="Preview"] desaparece).
 *  2. No hay icono "msg-time" (reloj) visible — significa que ningún mensaje
 *     está pendiente de subir.
 *
 * Timeout por tipo de media (vídeos tardan más): ajustado al tamaño del archivo
 * con un mínimo generoso.
 */
async function waitForUploadComplete(
  page: Page,
  mediaPath: string,
  kind: MediaKind,
): Promise<void> {
  // Timeout base por tipo + ~1s por MB (muy conservador para conexiones lentas).
  const { size } = await stat(mediaPath).catch(() => ({ size: 0 } as { size: number }));
  const perMbMs = 1_500;
  const sizeMb = size / (1024 * 1024);
  const base =
    kind === 'video' ? 180_000 : kind === 'audio' ? 90_000 : 30_000;
  const total = Math.min(600_000, base + Math.ceil(sizeMb) * perMbMs);
  logger.info({ kind, sizeMb: sizeMb.toFixed(2), timeout: total }, 'waiting for upload to complete');

  // 1) Preview debe cerrarse.
  try {
    await page.waitForSelector('img[alt="Preview"], video[src^="blob:"]', {
      state: 'detached',
      timeout: total,
    });
    logger.debug('preview overlay closed');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'preview overlay did not close in time — continuing to pending check',
    );
  }

  // 2) Esperar a que NO queden iconos "msg-time" (reloj = subiendo/pendiente).
  const deadline = Date.now() + total;
  while (Date.now() < deadline) {
    const pending = await page
      .locator('span[data-icon="msg-time"]')
      .count()
      .catch(() => 0);
    if (pending === 0) {
      logger.info('upload completed — no pending messages');
      return;
    }
    logger.debug({ pending }, 'upload still pending');
    await page.waitForTimeout(1500);
  }

  logger.warn('upload did not complete within timeout — closing anyway');
}

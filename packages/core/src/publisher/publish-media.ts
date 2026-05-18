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
  typeMultiline,
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

/**
 * Timeouts escalados por tamaño del archivo.
 *
 * El problema con timeouts fijos es que un vídeo de 30s (~10 MB) y uno de
 * 3 min (~200 MB) tardan órdenes de magnitud distintos en:
 *   1. generar preview (WA parsea el contenedor en cliente),
 *   2. tener metadata disponible (readyState >= 1),
 *   3. subirse al servidor.
 *
 * Para cada etapa definimos (base + perMbMs * size) con un máximo duro para
 * que un error real no nos cuelgue para siempre.
 */
interface TimeoutSpec {
  baseMs: number;
  perMbMs: number;
  maxMs: number;
}

const TIMEOUTS: Record<MediaKind, { preview: TimeoutSpec; upload: TimeoutSpec }> & {
  videoReady: TimeoutSpec;
} = {
  image: {
    preview: { baseMs: 25_000, perMbMs: 500, maxMs: 120_000 },
    upload: { baseMs: 60_000, perMbMs: 1_500, maxMs: 300_000 },
  },
  video: {
    // Preview: WA Web tiene que decodificar el container y sacar el primer frame.
    // Un vídeo grande puede tardar bastante aunque todavía no haya empezado a subir.
    preview: { baseMs: 90_000, perMbMs: 2_000, maxMs: 600_000 /* 10 min */ },
    // Upload: lo más lento. En red doméstica española típica (~10-20 Mbps subida),
    // 100 MB tardan 40-80 s. Añadimos margen 3x para cuando haya congestión.
    upload: { baseMs: 240_000, perMbMs: 6_000, maxMs: 1_800_000 /* 30 min */ },
  },
  audio: {
    preview: { baseMs: 45_000, perMbMs: 1_500, maxMs: 300_000 },
    upload: { baseMs: 120_000, perMbMs: 4_000, maxMs: 600_000 },
  },
  document: {
    preview: { baseMs: 25_000, perMbMs: 500, maxMs: 180_000 },
    upload: { baseMs: 90_000, perMbMs: 3_000, maxMs: 600_000 },
  },
  videoReady: { baseMs: 60_000, perMbMs: 3_000, maxMs: 600_000 },
};

function scaledTimeout(spec: TimeoutSpec, sizeMb: number): number {
  return Math.min(spec.maxMs, spec.baseMs + Math.ceil(sizeMb * spec.perMbMs));
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
  const fileStat = await stat(input.mediaPath);
  const sizeMb = fileStat.size / (1024 * 1024);
  const mediaSha256 = await sha256OfFile(input.mediaPath);
  logger.info(
    { kind: input.mediaKind, sizeMb: sizeMb.toFixed(2), sizeBytes: fileStat.size },
    'publishMedia start',
  );

  const context = await launchPersistentContextForTenant();
  let debugDump: string | undefined;

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
    await waitForAny(page, SELECTORS.appReady, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);

    await attachMedia(page, input.mediaPath, input.mediaKind);
    await waitForMediaPreview(page, input.mediaKind, sizeMb);
    await assertNotStickerPreview(page);

    // Escribimos el caption YA (mientras el vídeo sigue cargando). Así el
    // texto está presente en el composer antes de que WA termine de
    // procesar el media — si escribimos después, WA puede re-renderizar el
    // preview al completar el load y perder el texto.
    if (input.body) await addCaption(page, input.body);

    // Para vídeo, esperamos a que esté listo ANTES de clicar Send.
    if (input.mediaKind === 'video') await waitForVideoReady(page, sizeMb);

    // Verificar que el Send está realmente clickable antes de pulsarlo.
    await waitForSendButtonReady(page);
    await sendFromPreview(page);

    // Esperar a que el upload termine: el preview debe cerrarse Y la burbuja
    // del mensaje debe aparecer en el hilo con el tick (msg-check / msg-dblcheck
    // / msg-time). Si cerramos el contexto antes, cancelamos el upload.
    await waitForUploadComplete(page, input.mediaKind, sizeMb);

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
async function waitForMediaPreview(
  page: Page,
  kind: MediaKind,
  sizeMb: number,
): Promise<void> {
  const timeout = scaledTimeout(TIMEOUTS[kind].preview, sizeMb);
  logger.info({ kind, sizeMb: sizeMb.toFixed(2), timeoutMs: timeout }, 'waiting for media preview');
  await waitForAny(page, SELECTORS.mediaPreviewReady, { timeout });
  await humanPause(page, [500, 900]);
  logger.info('media preview ready');
}

/**
 * Espera a que el vídeo esté listo para enviar (metadata cargada y duración
 * conocida). Se llama ANTES de `sendFromPreview` y DESPUÉS de escribir el
 * caption — así el caption ya está persistido en el DOM cuando WA termina
 * de procesar el vídeo.
 *
 * Timeout escalado por tamaño: vídeos grandes (>100 MB) necesitan bastante
 * más de los 60s que había fijados antes — WA Web parsea el contenedor
 * entero en cliente antes de exponer `readyState >= 1`.
 */
async function waitForVideoReady(page: Page, sizeMb: number): Promise<void> {
  const timeout = scaledTimeout(TIMEOUTS.videoReady, sizeMb);
  logger.info({ sizeMb: sizeMb.toFixed(2), timeoutMs: timeout }, 'waiting for video metadata');
  try {
    await page.waitForFunction(
      `(() => {
        const v = document.querySelector('video[src^="blob:"]');
        return !!v && v.readyState >= 1 && !isNaN(v.duration) && v.duration > 0;
      })()`,
      undefined,
      { timeout },
    );
    logger.info('video metadata loaded');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), timeoutMs: timeout },
      'video metadata not confirmed — continuing anyway',
    );
  }
}

/**
 * Espera a que el botón Send esté disponible y no deshabilitado. Para vídeos
 * grandes, WA Web renderiza el botón en un estado no-clickable (aria-disabled
 * o display:none) hasta que el procesado local termina. Si clicamos antes,
 * el click se pierde y luego no arranca el upload.
 */
async function waitForSendButtonReady(page: Page, timeoutMs = 30_000): Promise<void> {
  // El aria-label varía: "Send", "Send 1 selected", "Send 3 selected"…
  // (Channels media preview). Usamos prefix-match.
  const selectors = [
    'div[role="button"][aria-label^="Send"]:not([aria-disabled="true"])',
    'div[role="button"][aria-label^="Enviar"]:not([aria-disabled="true"])',
    'button[aria-label^="Send"]:not([disabled])',
    'button[aria-label^="Enviar"]:not([disabled])',
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) {
        logger.debug({ selector: sel }, 'send button is ready');
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  logger.warn({ timeoutMs }, 'send button readiness not confirmed — trying to click anyway');
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
  // typeMultiline preserva saltos de línea con Shift+Enter — sin esto, un
  // `\n` en el caption enviaría el mensaje a medias en WA Channels.
  await typeMultiline(page, caption, body, { delayMs: 50 });
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

  // Scope a la caja del preview: el ancestro más cercano del input "Type an
  // update" que también contiene un botón Send. Esto evita que clickemos en
  // un wds-ic-send-filled que esté en otro lado (p. ej. en otro composer
  // que WA pinte detrás).
  //
  // aria-label en WA Channels suele llevar sufijo dinámico: "Send 1 selected".
  // Usamos starts-with() en XPath y prefix-match en CSS.
  const previewScope = page.locator(
    'xpath=//*[.//div[@contenteditable="true" and @aria-label="Type an update"] and .//*[(@role="button" or self::button) and (starts-with(@aria-label, "Send") or starts-with(@aria-label, "Enviar"))]][1]',
  ).first();
  const hasScope = (await previewScope.count().catch(() => 0)) > 0;
  const scope = hasScope ? previewScope : null;
  if (!hasScope) {
    logger.warn('preview scope not found — falling back to global search');
  }

  type Attempt = { sel: string; label: string };
  const attempts: Attempt[] = [
    { sel: 'div[role="button"][aria-label^="Send"]', label: 'send' },
    { sel: 'div[role="button"][aria-label^="Enviar"]', label: 'send-es' },
    { sel: 'button[aria-label^="Send"]', label: 'send-btn' },
    { sel: 'button[aria-label^="Enviar"]', label: 'send-btn-es' },
  ];
  for (const { sel, label } of attempts) {
    const loc = (scope ?? page).locator(sel).first();
    const cnt = await loc.count().catch(() => 0);
    if (cnt === 0) continue;
    try {
      await loc.click({ timeout: 4_000 });
      logger.info({ selector: sel, label, scoped: !!scope }, 'media sent');
      return;
    } catch (err) {
      logger.debug({ selector: sel, err }, 'click failed, trying next');
    }
  }

  // Fallback: localizar el icono dentro del scope (si lo hay) y subir al
  // ancestro clicable. NUNCA buscar el icono sin scope: ahí está el bug del
  // falso positivo (puede haber wds-ic-send-filled en otro composer).
  if (scope) {
    const iconSelectors = [
      'span[data-icon="wds-ic-send-filled"]',
      'span[data-icon="send"]',
    ];
    for (const sel of iconSelectors) {
      const icon = scope.locator(sel).first();
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
        logger.info({ selector: sel, scoped: true }, 'media sent (icon fallback)');
        return;
      } catch (err) {
        logger.debug({ selector: sel, err }, 'icon click failed, trying next');
      }
    }
  }

  throw new Error('sendFromPreview: no clickable Send button inside preview overlay');
}

/**
 * Espera a que el upload del media termine antes de cerrar el navegador.
 *
 * WA Web hace el upload tras clicar Send; si cerramos el contexto demasiado
 * pronto, el request se cancela y el mensaje no llega nunca.
 *
 * Etapas observables:
 *  1. Preview overlay se cierra → WA ha aceptado el envío localmente.
 *  2. Aparece burbuja en el hilo con icono "msg-time" (reloj = subiendo).
 *  3. El reloj desaparece → el mensaje está entregado (check / doble check).
 *
 * Para vídeos grandes (p. ej. >100 MB) los pasos 1 y 3 pueden tardar varios
 * minutos. Cada etapa tiene su propio deadline basado en el tamaño.
 *
 * Además instrumentamos con logs cada 10s para saber dónde se queda el
 * proceso si falla.
 */
async function waitForUploadComplete(
  page: Page,
  kind: MediaKind,
  sizeMb: number,
): Promise<void> {
  const total = scaledTimeout(TIMEOUTS[kind].upload, sizeMb);
  logger.info(
    { kind, sizeMb: sizeMb.toFixed(2), timeoutMs: total, timeoutMin: (total / 60_000).toFixed(1) },
    'waiting for upload to complete',
  );

  const startedAt = Date.now();
  const overallDeadline = startedAt + total;

  // 1) Preview debe cerrarse. Asignamos hasta el 40% del presupuesto a esta
  //    fase (en la práctica suele cerrarse casi instantáneo tras el click).
  const previewDeadline = Math.min(
    overallDeadline,
    Date.now() + Math.max(60_000, Math.floor(total * 0.4)),
  );
  try {
    await page.waitForSelector('img[alt="Preview"], video[src^="blob:"]', {
      state: 'detached',
      timeout: previewDeadline - Date.now(),
    });
    logger.info({ elapsedMs: Date.now() - startedAt }, 'preview overlay closed');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'preview overlay did not close in time — continuing to pending check',
    );
  }

  // 2) CRÍTICO: necesitamos PRUEBA de que el envío llegó a iniciarse. Si el
  //    Send "fantasma" (click en un elemento equivocado) cerró el preview pero
  //    no encoló nada, NINGÚN indicador aparecerá. Antes el bucle daba esto
  //    por exitoso ("0 pendientes = ok") — falso positivo flagrante.
  //
  //    Esperamos hasta ~15s a que aparezca CUALQUIERA de:
  //      - msg-time   → mensaje pendiente de subir
  //      - msg-check  → entregado
  //      - msg-dblcheck → leído
  //      - msg-failed o aria-label "Reintentar" → WA mismo reporta fallo
  //
  //    Si no aparece ninguno, el "envío" no ocurrió. Throw → job marcado failed.
  const indicatorSelector =
    'span[data-icon="msg-time"], span[data-icon="msg-check"], span[data-icon="msg-dblcheck"], span[data-icon="msg-failed"], [aria-label*="Reintentar" i], [aria-label*="Retry" i]';
  let indicatorAppeared = false;
  const indicatorDeadline = Date.now() + 15_000;
  while (Date.now() < indicatorDeadline) {
    const cnt = await page.locator(indicatorSelector).count().catch(() => 0);
    if (cnt > 0) {
      indicatorAppeared = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!indicatorAppeared) {
    throw new Error(
      'send verification failed: no message indicator appeared after Send click — likely clicked the wrong element',
    );
  }

  // 3) Esperar a que NO queden iconos "msg-time" (reloj = subiendo/pendiente).
  //    Log cada 10s con el número de pendientes para poder diagnosticar red lenta.
  let lastLog = Date.now();
  let lastPending = -1;
  while (Date.now() < overallDeadline) {
    const [pending, failed] = await Promise.all([
      page.locator('span[data-icon="msg-time"]').count().catch(() => 0),
      page.locator('span[data-icon="msg-failed"], [aria-label*="Retry" i], [aria-label*="Reintentar" i]').count().catch(() => 0),
    ]);

    if (failed > 0) {
      throw new Error(`upload marked as failed by WhatsApp (retry indicator found)`);
    }
    if (pending === 0) {
      logger.info({ elapsedMs: Date.now() - startedAt }, 'upload completed — no pending messages');
      return;
    }

    // Log periódico de progreso (cada 10s o cuando cambie el número de pendientes).
    if (pending !== lastPending || Date.now() - lastLog > 10_000) {
      const remainingMs = overallDeadline - Date.now();
      logger.info(
        { pending, remainingSec: Math.round(remainingMs / 1000) },
        'upload still pending',
      );
      lastPending = pending;
      lastLog = Date.now();
    }
    await page.waitForTimeout(2000);
  }

  logger.warn({ timeoutMs: total }, 'upload did not complete within timeout — closing anyway');
}

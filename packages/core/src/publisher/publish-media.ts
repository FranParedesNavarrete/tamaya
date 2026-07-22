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
  replaceEditableText,
  waitForAny,
} from '../browser/dom-helpers.js';
import { logger } from '../logger.js';
import { navigateToChannel } from './publish-text.js';
import {
  findLastThreadTexts,
  findPageVisibleText,
  detectMediaInLastItems,
  textMatchesAny,
  type VerificationObserved,
} from './verify.js';
import type { PublishVerificationMeta } from '@tamaya/shared-types';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface PublishMediaInput {
  channelIdentifier: {
    inviteLink?: string;
    whatsappId?: string;
    name: string;
  };
  body?: string;
  /** Primer archivo / compatibilidad histórica. */
  mediaPath: string;
  /** Varios archivos en una misma publicación de WhatsApp Channels. */
  mediaPaths?: string[];
  mediaKind: MediaKind;
}

export interface PublishResult {
  success: boolean;
  durationMs: number;
  mediaSha256?: string;
  error?: string;
  debugDump?: string;
  verificationMeta?: PublishVerificationMeta;
  /**
   * true si el fallo ocurrió DESPUÉS de pulsar Send (contenido quizá ya
   * publicado). worker-publish NO debe reintentar en este caso para no
   * duplicar la publicación.
   */
  postSendMaybeDelivered?: boolean;
}

/** Parseo seguro de un entero desde env; fallback + warning si inválido. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn({ name, raw, fallback }, 'invalid env value — using fallback');
    return fallback;
  }
  return Math.floor(n);
}

// Timeouts de upload configurables por .env (aplican al caso más lento: vídeo).
const UPLOAD_TIMEOUT_MAX_MS = envInt('TAMAYA_MEDIA_UPLOAD_TIMEOUT_MAX_MS', 1_800_000);
const UPLOAD_TIMEOUT_PER_MB_MS = envInt('TAMAYA_MEDIA_UPLOAD_TIMEOUT_PER_MB_MS', 6_000);

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
    // 100 MB tardan 40-80 s. Configurable por .env (por-MB y tope duro).
    upload: { baseMs: 240_000, perMbMs: UPLOAD_TIMEOUT_PER_MB_MS, maxMs: UPLOAD_TIMEOUT_MAX_MS },
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
  const mediaPaths = input.mediaPaths && input.mediaPaths.length > 0
    ? input.mediaPaths
    : [input.mediaPath];
  const fileStats = await Promise.all(mediaPaths.map((p) => stat(p)));
  const totalSizeBytes = fileStats.reduce((sum, s) => sum + s.size, 0);
  const sizeMb = totalSizeBytes / (1024 * 1024);
  const mediaSha256 = await sha256OfFiles(mediaPaths);
  logger.info(
    { kind: input.mediaKind, count: mediaPaths.length, sizeMb: sizeMb.toFixed(2), sizeBytes: totalSizeBytes },
    'publishMedia start',
  );

  const context = await launchPersistentContextForTenant();
  let debugDump: string | undefined;
  let sendClicked = false;

  const expected: PublishVerificationMeta['expected'] = {
    hasText: Boolean(input.body && input.body.length > 0),
    textLength: input.body?.length ?? 0,
    hasMedia: true,
    mediaKind: input.mediaKind,
    mediaSha256,
  };

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
    await waitForAny(page, SELECTORS.appReady, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);

    await attachMedia(page, mediaPaths, input.mediaKind);
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
    const threadMarkersBeforeSend = await countThreadMarkers(page);

    // ---- PUNTO DE NO RETORNO: a partir de aquí, el contenido puede haberse
    // publicado, así que un fallo NO debe reintentarse automáticamente. ----
    await sendFromPreview(page);
    sendClicked = true;

    const observed = await verifyAfterSend(page, {
      kind: input.mediaKind,
      sizeMb,
      body: input.body,
      threadMarkersBeforeSend,
    });

    const { result, reason } = decideResult(expected, observed);
    const verificationMeta: PublishVerificationMeta = {
      expected,
      observed,
      result,
      reason,
      checkedAt: new Date().toISOString(),
    };

    if (result === 'verified') {
      logger.info({ observed }, 'publishMedia verified');
      return { success: true, durationMs: Date.now() - started, mediaSha256, verificationMeta };
    }

    // Post-send sin confirmación clara → NO reintentar (posible duplicado).
    const page0 = context.pages()[0];
    if (page0) {
      try { debugDump = await dumpDebugInfo(page0, 'publish-media-verify'); } catch { /* logged */ }
    }
    logger.warn({ result, reason, observed }, 'publishMedia post-send verification not confirmed');
    return {
      success: false,
      durationMs: Date.now() - started,
      mediaSha256,
      error: reason ?? 'post-send verification failed',
      debugDump,
      verificationMeta,
      postSendMaybeDelivered: true,
    };
  } catch (err) {
    const page = context.pages()[0];
    if (page) {
      try {
        debugDump = await dumpDebugInfo(page, 'publish-media-fail');
      } catch {
        /* ya logueado */
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sendClicked }, 'publishMedia failed');
    // Si ya habíamos pulsado Send, el error es post-send → ambiguo, no reintentar.
    const verificationMeta: PublishVerificationMeta | undefined = sendClicked
      ? {
          expected,
          observed: {
            previewClosed: false, sendClicked: true, indicatorAppeared: false,
            threadItemAppeared: false, textMatched: 'unknown', mediaDetected: 'unknown',
            uploadPendingCleared: 'unknown',
          },
          result: 'ambiguous_after_send',
          reason: errMsg,
          checkedAt: new Date().toISOString(),
        }
      : undefined;
    return {
      success: false,
      durationMs: Date.now() - started,
      mediaSha256,
      error: errMsg,
      debugDump,
      verificationMeta,
      postSendMaybeDelivered: sendClicked,
    };
  } finally {
    await context.close();
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function sha256OfFiles(paths: string[]): Promise<string> {
  if (paths.length === 1) return sha256OfFile(paths[0]);
  const hashes = await Promise.all(paths.map(sha256OfFile));
  return createHash('sha256').update(hashes.join(':')).digest('hex');
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
async function attachMedia(page: Page, paths: string[], kind: MediaKind): Promise<void> {
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
    await fileChooser.setFiles(paths);
    logger.info({ paths, count: paths.length }, 'media attached via Photos & videos filechooser');
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
      await input.setInputFiles(paths);
      logger.info({ selector: sel, paths, count: paths.length }, 'media attached (fallback input)');
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
  // Pegar el caption completo es más estable para copies largos con saltos.
  await replaceEditableText(page, caption, body, { delayMs: 50 });
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
async function countThreadMarkers(page: Page): Promise<number> {
  // WA Channels no siempre renderiza los ticks msg-time/msg-check que usamos
  // en chats normales. Como señal adicional contamos filas/burbujas del hilo
  // antes/después de clicar Send: si aumenta, el mensaje sí se insertó.
  const selectors = [
    'div[role="row"]',
    'div.message-out',
    'div[data-pre-plain-text]',
  ];
  const counts = await Promise.all(
    selectors.map((sel) => page.locator(sel).count().catch(() => 0)),
  );
  return Math.max(...counts);
}

const INDICATOR_SELECTOR =
  'span[data-icon="msg-time"], span[data-icon="msg-check"], span[data-icon="msg-dblcheck"]';
const FAILED_SELECTOR =
  'span[data-icon="msg-failed"], [aria-label*="Reintentar" i], [aria-label*="Retry" i]';

/**
 * Verifica el resultado tras pulsar Send, SIN depender solo de los ticks
 * (WhatsApp Channels a veces no los muestra). Devuelve señales observadas para
 * auditoría; no lanza (el llamador decide con `decideResult`).
 */
async function verifyAfterSend(
  page: Page,
  opts: { kind: MediaKind; sizeMb: number; body?: string; threadMarkersBeforeSend: number },
): Promise<VerificationObserved> {
  const { kind, sizeMb, body, threadMarkersBeforeSend } = opts;
  const total = scaledTimeout(TIMEOUTS[kind].upload, sizeMb);
  const startedAt = Date.now();
  const overallDeadline = startedAt + total;

  const observed: VerificationObserved = {
    previewClosed: false,
    sendClicked: true,
    indicatorAppeared: false,
    threadItemAppeared: false,
    textMatched: 'unknown',
    mediaDetected: 'unknown',
    uploadPendingCleared: 'unknown',
  };

  // 1) El preview debe cerrarse (WA aceptó el envío localmente).
  const previewBudget = Math.max(60_000, Math.floor(total * 0.4));
  try {
    await page.waitForSelector('img[alt="Preview"], video[src^="blob:"]', {
      state: 'detached',
      timeout: Math.min(previewBudget, overallDeadline - Date.now()),
    });
    observed.previewClosed = true;
    logger.info({ elapsedMs: Date.now() - startedAt }, 'preview overlay closed');
  } catch {
    logger.warn('preview overlay did not close in time');
  }

  // 2) Evidencia de inserción: indicador (tick) o nuevo item en el hilo.
  const indicatorDeadline = Date.now() + 15_000;
  while (Date.now() < indicatorDeadline) {
    if ((await page.locator(INDICATOR_SELECTOR).count().catch(() => 0)) > 0) {
      observed.indicatorAppeared = true;
      break;
    }
    if ((await countThreadMarkers(page)) > threadMarkersBeforeSend) {
      observed.threadItemAppeared = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  // Reconfirmar item aunque el indicador ganase la carrera.
  if (!observed.threadItemAppeared) {
    observed.threadItemAppeared = (await countThreadMarkers(page)) > threadMarkersBeforeSend;
  }

  // 3) Verificación de CONTENIDO real (independiente de los ticks).
  if (body && body.length > 0) {
    const texts = await findLastThreadTexts(page, 5);
    const pageText = await findPageVisibleText(page);
    observed.textMatched = textMatchesAny(body, [...texts, pageText]);
  } else {
    observed.textMatched = 'unknown';
  }
  observed.mediaDetected = await detectMediaInLastItems(page, 5);

  // 4) Esperar a que no queden pendientes (msg-time) ni fallos (msg-failed).
  let lastLog = Date.now();
  while (Date.now() < overallDeadline) {
    const [pending, failed] = await Promise.all([
      page.locator('span[data-icon="msg-time"]').count().catch(() => 0),
      page.locator(FAILED_SELECTOR).count().catch(() => 0),
    ]);
    if (failed > 0) {
      observed.uploadPendingCleared = false;
      logger.warn('upload marked as failed by WhatsApp (retry indicator found)');
      return observed;
    }
    if (pending === 0) {
      observed.uploadPendingCleared = true;
      logger.info({ elapsedMs: Date.now() - startedAt }, 'upload completed — no pending');
      return observed;
    }
    if (Date.now() - lastLog > 10_000) {
      logger.info({ pending, remainingSec: Math.round((overallDeadline - Date.now()) / 1000) }, 'upload still pending');
      lastLog = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  // Timeout con pendientes → no podemos afirmar que terminó.
  observed.uploadPendingCleared = 'unknown';
  logger.warn({ timeoutMs: total }, 'upload did not clear pending within timeout');
  return observed;
}

/**
 * Decide el resultado a partir de las señales observadas, priorizando NO
 * duplicar: solo 'verification_failed' (retryable) cuando hay evidencia de que
 * NO se publicó; el resto post-send es 'ambiguous_after_send' (no retry).
 */
function decideResult(
  expected: PublishVerificationMeta['expected'],
  o: VerificationObserved,
): { result: PublishVerificationMeta['result']; reason?: string } {
  const deliveredEvidence = o.indicatorAppeared || o.threadItemAppeared;

  const textOk = !expected.hasText || o.textMatched === true;
  const mediaOk = !expected.hasMedia || o.mediaDetected === true;
  const expectedContentVerified = textOk && mediaOk;

  // Fallo explícito de WA y sin evidencia de contenido correcto → no se publicó, retryable.
  if (o.uploadPendingCleared === false && !deliveredEvidence && !expectedContentVerified) {
    return { result: 'verification_failed', reason: 'WhatsApp marcó el envío como fallido y no apareció contenido esperado' };
  }

  // En Channels los ticks y el conteo de burbujas pueden no aparecer aunque el
  // contenido sí esté visible en los últimos items. Si encontramos TODO lo que
  // esperábamos (caption/texto y media), el preview cerró y no hay fallo de
  // subida, lo consideramos verificado aunque no haya ticks.
  if (expectedContentVerified && o.previewClosed && o.uploadPendingCleared !== false) {
    return { result: 'verified' };
  }

  if (deliveredEvidence && textOk && (!expected.hasMedia || o.mediaDetected !== false) && o.uploadPendingCleared !== false) {
    return { result: 'verified' };
  }

  // Cualquier otra situación tras pulsar Send: no confirmamos, no reintentar.
  const reasons: string[] = [];
  if (!deliveredEvidence) reasons.push('sin indicador ni item nuevo en el hilo');
  if (expected.hasText && o.textMatched !== true) reasons.push('caption/texto no confirmado en el hilo');
  if (expected.hasMedia && o.mediaDetected === false) reasons.push('media no detectada en el hilo');
  if (o.uploadPendingCleared === false) reasons.push('WhatsApp marcó fallo de subida');
  if (o.uploadPendingCleared === 'unknown') reasons.push('subida no confirmada (timeout)');
  return { result: 'ambiguous_after_send', reason: reasons.join('; ') || 'contenido no verificable tras enviar' };
}

# Tamaya — Parches publish-media (texto + adjunto)

Continuación del documento `PATCHES-whatsapp-web-v2026-04-17.md`. Cubre el siguiente objetivo del backlog: publicar **texto + adjunto** (imagen, vídeo, audio, documento) en un canal de WhatsApp.

**Pre-requisitos**: los 5 parches del documento anterior aplicados y `npm run publish -c "..." -t "..."` funcionando end-to-end.

**Fecha**: 2026-04-17
**Archivos afectados**: `src/browser/selectors.ts`, `src/publisher/publish-media.ts`, `src/cli/publish.ts` (o el CLI que uses), `src/db/*` (opcional, para `message_media`)

---

## Tabla de contenidos

1. [Flujo UI de referencia (WhatsApp Web)](#flujo)
2. [Parche M1 — Selectores de media](#m1)
3. [Parche M2 — Clasificador MIME → ruta de adjunto](#m2)
4. [Parche M3 — Función `publishMedia`](#m3)
5. [Parche M4 — CLI `-m/--media`](#m4)
6. [Parche M5 — Verificación post-envío de media](#m5)
7. [Debug: cómo dumpear el preview modal](#debug)
8. [Limitaciones conocidas](#limits)

---

<a id="flujo"></a>
## Flujo UI de referencia

```
[Canal abierto, composer visible]
        ↓ click attach (+)
[Menú dropdown: Fotos y vídeos | Cámara | Documento | ...]
        ↓ click opción
[<input type=file> invisible recibe el path]
        ↓ setInputFiles
[Preview modal fullscreen: imagen/vídeo/doc renderizado + caption input + send]
        ↓ (opcional) tipear caption
        ↓ click send
[Vuelta al hilo; burbuja nueva con el media]
```

**Detalle importante del preview**:
- El caption input NO es el mismo que el composer principal.
- Su aria-label suele ser "Añadir un pie de foto" / "Add a caption" o similar.
- El send button en el preview es distinto del send del composer: suele tener `data-icon="wds-ic-send-filled"` o ser un botón con aria-label "Enviar".
- Para múltiples adjuntos, el preview tiene thumbnails en la parte inferior (un solo caption aplica al conjunto, aunque también se puede poner caption por archivo desde v2024).

---

<a id="m1"></a>
## Parche M1 — Selectores de media

Amplía los selectores de `selectors.ts`. Los que ya tenías (attachButton, fileInputImageVideo, fileInputDocument, mediaPreviewReady, captionInputOnPreview) se mantienen, pero añadimos más granularidad.

### Cambios en `src/browser/selectors.ts`

Añade estas claves al objeto `SELECTORS`. Si alguna ya existe con el mismo nombre, sustituye por esta versión (más completa):

```typescript
  // --- Adjuntar media ---

  /**
   * Botón "+" (adjuntar) junto al composer.
   * Verificado 2026-04-17: WA usa un <button> con aria-label en español/inglés.
   */
  attachButton: [
    'button[aria-label="Adjuntar"]',
    'button[aria-label="Attach"]',
    'div[role="button"][aria-label="Adjuntar"]',
    'div[role="button"][aria-label="Attach"]',
    'button[title="Adjuntar"]',
    'button[title="Attach"]',
    // Fallback por icono (menos estable)
    'span[data-icon="plus"]',
    'span[data-icon="plus-rounded"]',
    'span[data-icon="clip"]',
  ],

  /**
   * Opciones del menú dropdown que se abre tras click en adjuntar.
   * Cada opción corresponde a un <input type="file"> oculto.
   */
  attachMenuOption: {
    photosVideos: [
      'li[data-animate-dropdown-item="true"]:has-text("Fotos y vídeos")',
      'li[data-animate-dropdown-item="true"]:has-text("Photos & Videos")',
      'li[data-animate-dropdown-item="true"]:has-text("Photos and Videos")',
      'div[role="button"][aria-label="Fotos y vídeos"]',
      'div[role="button"][aria-label="Photos & Videos"]',
      'button:has-text("Fotos y vídeos")',
      'button:has-text("Photos & Videos")',
    ],
    document: [
      'li[data-animate-dropdown-item="true"]:has-text("Documento")',
      'li[data-animate-dropdown-item="true"]:has-text("Document")',
      'div[role="button"][aria-label="Documento"]',
      'div[role="button"][aria-label="Document"]',
      'button:has-text("Documento")',
      'button:has-text("Document")',
    ],
  },

  /**
   * Inputs de fichero que WA monta ocultos.
   * Playwright los acepta aunque tengan display:none/visibility:hidden.
   * Tras abrir la opción del menú, el input correspondiente queda disponible.
   */
  fileInputImageVideo: [
    'input[type="file"][accept*="image"][accept*="video"]',
    'input[type="file"][accept*="image/"][accept*="video/"]',
    'input[type="file"][accept*="image"]',
  ],

  fileInputDocument: [
    // WA usa accept="*" o directamente sin accept para el input de documentos
    'input[type="file"][accept="*"]',
    'input[type="file"]:not([accept])',
    'input[type="file"][accept=""]',
  ],

  /**
   * Preview modal. Indicador de que el archivo se cargó correctamente.
   * Usamos varios indicadores posibles: dialog visible con imagen/video/doc dentro.
   */
  mediaPreviewReady: [
    'div[role="dialog"]:has(img[src^="blob:"])',
    'div[role="dialog"]:has(video)',
    'div[role="dialog"]:has(canvas)',
    // WA usa un overlay full-screen con un div específico para el preview
    'div[class*="preview"]:has(img)',
    'div[class*="preview"]:has(video)',
    // Fallback por presencia del caption input
    'div:has(> * > * > div[contenteditable="true"][aria-placeholder*="pie" i])',
    'div:has(> * > * > div[contenteditable="true"][aria-placeholder*="caption" i])',
  ],

  /**
   * Caption input dentro del preview. Distinto al composer principal.
   * aria-label/placeholder referencian "pie de foto" (ES) / "caption" (EN).
   */
  captionInputOnPreview: [
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="pie" i]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="caption" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="pie" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="caption" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="leyenda" i]',
    'div[contenteditable="true"][data-lexical-editor="true"][aria-placeholder*="pie" i]',
    'div[contenteditable="true"][data-lexical-editor="true"][aria-placeholder*="caption" i]',
    // Último recurso: el único textbox dentro del dialog del preview
    'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
  ],

  /**
   * Botón enviar DEL PREVIEW MODAL. Distinto del send del composer.
   * Suele ser un <button> con aria-label "Enviar" dentro del dialog.
   */
  previewSendButton: [
    'div[role="dialog"] button[aria-label="Enviar"]',
    'div[role="dialog"] button[aria-label="Send"]',
    'div[role="dialog"] div[role="button"][aria-label="Enviar"]',
    'div[role="dialog"] div[role="button"][aria-label="Send"]',
    'div[role="dialog"] span[data-icon="send"]',
    'div[role="dialog"] span[data-icon="wds-ic-send-filled"]',
  ],

  /**
   * Botón X para cerrar el preview modal (abortar sin enviar).
   * Útil para cleanup si algo falla a mitad.
   */
  previewCloseButton: [
    'div[role="dialog"] button[aria-label="Cerrar"]',
    'div[role="dialog"] button[aria-label="Close"]',
    'div[role="dialog"] div[role="button"][aria-label="Cerrar"]',
  ],

  /**
   * Última burbuja con media, para verificación.
   * Distingue entre imagen/vídeo/documento.
   */
  lastMediaBubble: {
    anyMedia: [
      'div[role="row"]:last-of-type:has(img[src^="blob:"])',
      'div[role="row"]:last-of-type:has(video)',
      'div[role="row"]:last-of-type:has([data-icon="audio-file"])',
      'div[role="row"]:last-of-type:has([data-icon="document"])',
      'div[role="row"]:last-of-type:has([data-icon="msg-attachment"])',
    ],
    image: [
      'div[role="row"]:last-of-type img[src^="blob:"]',
      'div.message-out:last-of-type img[src^="blob:"]',
    ],
    video: [
      'div[role="row"]:last-of-type video',
      'div.message-out:last-of-type video',
    ],
    document: [
      'div[role="row"]:last-of-type [data-icon="document"]',
      'div[role="row"]:last-of-type [data-icon="audio-file"]',
      'div[role="row"]:last-of-type [data-icon="msg-attachment"]',
    ],
  },
```

También sube `SELECTORS_VERSION` a `0.4.0`.

### Verificación rápida

Tras aplicar y compilar:

```bash
npm run inspect -- --dump 'button[aria-label="Adjuntar"]'  # 1 match
npm run inspect -- --dump 'input[type="file"]'             # varios matches (WA monta varios)
```

---

<a id="m2"></a>
## Parche M2 — Clasificador MIME → ruta de adjunto

WA Web tiene dos rutas principales para subir archivos:

- **Fotos y vídeos**: `image/*`, `video/*` (con thumbnails y preview nativo)
- **Documento**: todo lo demás (audio, PDF, ZIP, etc.) — se envía como archivo genérico con icono + nombre

Los audios (mp3, wav, m4a, ogg) van por **Documento** en desktop (no hay ruta "audio" separada como sí hay en móvil). Esto es importante: aunque el MIME sea `audio/*`, la ruta UI es la de documento.

### Código: `src/publisher/media-routing.ts`

Archivo nuevo:

```typescript
/**
 * Determina qué opción del menú "Adjuntar" usar según el tipo de archivo.
 *
 * WhatsApp Web desktop tiene 2 rutas principales para upload de ficheros:
 *  - "Fotos y vídeos": image/* y video/*
 *  - "Documento": todo lo demás (audio incluido, PDF, office, zip, etc.)
 */

import { extname } from 'node:path';

export type AttachRoute = 'photosVideos' | 'document';

export interface MediaRoutingInfo {
  route: AttachRoute;
  mime: string;
  ext: string;
}

// Mínimo viable — podemos ampliar más adelante
const EXT_TO_MIME: Record<string, string> = {
  // Imágenes
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  // Vídeos
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  // Audio (van por "Documento")
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  // Documentos
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

export function classifyMedia(filePath: string): MediaRoutingInfo {
  const ext = extname(filePath).toLowerCase();
  const mime = EXT_TO_MIME[ext] ?? 'application/octet-stream';

  // image/* y video/* → Fotos y vídeos. Todo lo demás → Documento.
  const route: AttachRoute =
    mime.startsWith('image/') || mime.startsWith('video/')
      ? 'photosVideos'
      : 'document';

  return { route, mime, ext };
}
```

### Test manual

```typescript
// (solo para sanity check, opcional)
import { classifyMedia } from './media-routing.js';

console.log(classifyMedia('/tmp/foto.jpg'));      // { route: 'photosVideos', mime: 'image/jpeg', ext: '.jpg' }
console.log(classifyMedia('/tmp/song.mp3'));      // { route: 'document', mime: 'audio/mpeg', ext: '.mp3' }
console.log(classifyMedia('/tmp/invoice.pdf'));   // { route: 'document', mime: 'application/pdf', ext: '.pdf' }
console.log(classifyMedia('/tmp/clip.mp4'));      // { route: 'photosVideos', mime: 'video/mp4', ext: '.mp4' }
```

---

<a id="m3"></a>
## Parche M3 — Función `publishMedia`

### Estructura propuesta

`publishMedia` sigue la misma forma que `publishText`: navegar al canal, hacer el envío, verificar, persistir en DB. La diferencia es el paso de envío.

Reutiliza estas funciones de `publish-text.ts` (extrae a un módulo común si aún no lo están):

- `ensureChannelRow`
- `navigateToChannel`
- `dismissOnboardingOverlays`
- `confirmChannelOpen`

Si están privadas en `publish-text.ts`, la refactor mínima es: mueve esas funciones a `src/publisher/shared.ts` y exporta desde ahí. Importa en ambos módulos.

### Código: `src/publisher/publish-media.ts`

```typescript
/**
 * Publicación de texto + adjunto en un canal de WhatsApp.
 *
 * Flujo:
 *  1. Navegar al canal (reutiliza lógica de publish-text)
 *  2. Click botón adjuntar (+)
 *  3. Click opción del menú (Fotos y vídeos | Documento) según MIME
 *  4. setInputFiles al <input type=file> correspondiente
 *  5. Esperar preview modal
 *  6. Tipear caption en el composer del preview (si body != '')
 *  7. Click send del preview
 *  8. Verificar: última burbuja contiene el media esperado
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Page } from 'playwright';
import { launchPersistentContextForTenant, sessionExists } from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import {
  dumpDebugInfo,
  humanPause,
  waitForAny,
  waitForAnyDynamic,
} from '../browser/dom-helpers.js';
import { audit, db } from '../db/client.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { classifyMedia, type AttachRoute } from './media-routing.js';
// Asume que extrajiste estas a shared.ts; si no, ajusta el import.
import {
  ensureChannelRow,
  navigateToChannel,
  dismissOnboardingOverlays,
} from './shared.js';

export interface PublishMediaInput {
  channelIdentifier: {
    inviteLink?: string;
    whatsappId?: string;
    name: string;
  };
  mediaPath: string;       // Ruta absoluta al archivo
  caption?: string;        // Texto opcional que acompaña al media
}

export interface PublishResult {
  success: boolean;
  durationMs: number;
  messageId: string;
  debugDump?: string;
  error?: string;
}

export async function publishMedia(input: PublishMediaInput): Promise<PublishResult> {
  if (!sessionExists()) {
    return {
      success: false,
      durationMs: 0,
      messageId: '',
      error: 'No session found — run `npm run login` first',
    };
  }

  // Validar archivo antes de nada
  let fileSize: number;
  try {
    fileSize = statSync(input.mediaPath).size;
  } catch (err) {
    return {
      success: false,
      durationMs: 0,
      messageId: '',
      error: `media file not readable: ${input.mediaPath} (${err instanceof Error ? err.message : err})`,
    };
  }

  const routing = classifyMedia(input.mediaPath);
  const started = Date.now();
  const messageId = randomUUID();
  const caption = input.caption ?? '';

  logger.info(
    {
      file: basename(input.mediaPath),
      sizeBytes: fileSize,
      mime: routing.mime,
      route: routing.route,
      hasCaption: caption.length > 0,
    },
    'publishMedia start',
  );

  // Registro DB
  const channelDbId = ensureChannelRow(input.channelIdentifier);
  db.prepare(
    `INSERT INTO messages (id, tenant_id, channel_id, body, status)
     VALUES (?, ?, ?, ?, 'in_progress')`,
  ).run(messageId, config.tenantId, channelDbId, caption);

  // (Opcional) message_media: si tienes la tabla, guarda metadata del adjunto
  // db.prepare(`INSERT INTO message_media (...) VALUES (...)`).run(...);

  audit('user', 'publish_media_start', messageId, {
    channel: input.channelIdentifier.name,
    file: basename(input.mediaPath),
    mime: routing.mime,
  });

  const context = await launchPersistentContextForTenant();
  let debugDump: string | undefined;

  try {
    const page = context.pages()[0] ?? await context.newPage();

    logger.info('opening WhatsApp Web');
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

    logger.info('waiting for app to be ready');
    await waitForAny(page, SELECTORS.appReady, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);
    await dismissOnboardingOverlays(page);

    // --- Flujo media ---
    await openAttachMenu(page);
    await pickAttachRoute(page, routing.route);
    await uploadFile(page, routing.route, input.mediaPath);
    await waitForPreview(page);

    if (caption.length > 0) {
      await typeCaption(page, caption);
    }

    await sendFromPreview(page);

    // --- Verificación ---
    const verified = await verifyLastMediaMessage(page, routing.route, caption);
    if (!verified) {
      throw new Error('post-send verification failed — media not found in thread');
    }

    const durationMs = Date.now() - started;
    db.prepare(
      `UPDATE messages SET status='sent', sent_at=datetime('now'), duration_ms=? WHERE id=?`,
    ).run(durationMs, messageId);
    audit('system', 'publish_media_success', messageId, { durationMs, route: routing.route });

    return { success: true, durationMs, messageId };
  } catch (err) {
    const page = context.pages()[0];
    if (page) {
      try {
        debugDump = await dumpDebugInfo(page, 'publish-media-fail');
      } catch {
        /* ignore */
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - started;
    db.prepare(
      `UPDATE messages SET status='failed', last_error=?, duration_ms=?, attempted_count=attempted_count+1 WHERE id=?`,
    ).run(errMsg, durationMs, messageId);
    audit('system', 'publish_media_failed', messageId, { error: errMsg });
    logger.error({ err }, 'publishMedia failed');
    return { success: false, durationMs, messageId, error: errMsg, debugDump };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Pasos individuales del flujo
// ---------------------------------------------------------------------------

async function openAttachMenu(page: Page): Promise<void> {
  const btn = await waitForAny(page, SELECTORS.attachButton, { timeout: 10_000 });
  await humanPause(page, [200, 500]);
  await btn.click();
  // Pequeña espera para que el dropdown anime
  await page.waitForTimeout(400);
  logger.debug('attach menu opened');
}

async function pickAttachRoute(page: Page, route: AttachRoute): Promise<void> {
  const selectors = SELECTORS.attachMenuOption[route];
  try {
    const option = await waitForAnyDynamic(page, selectors, { timeout: 5_000 });
    await option.click();
    logger.debug({ route }, 'attach route selected');
    // No esperamos aquí — el input de fichero queda disponible inmediatamente
  } catch (err) {
    throw new Error(
      `could not find attach menu option "${route}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function uploadFile(page: Page, route: AttachRoute, filePath: string): Promise<void> {
  // Tras clickar la opción, el input[type=file] correspondiente queda "activo".
  // Playwright puede llenar inputs ocultos con setInputFiles directamente.
  const inputSelectors =
    route === 'photosVideos' ? SELECTORS.fileInputImageVideo : SELECTORS.fileInputDocument;

  let inputHandle = null;
  for (const sel of inputSelectors) {
    const handle = page.locator(sel).first();
    if ((await handle.count()) > 0) {
      inputHandle = handle;
      logger.debug({ selector: sel }, 'file input matched');
      break;
    }
  }
  if (!inputHandle) {
    throw new Error(`no matching file input for route=${route}`);
  }

  await inputHandle.setInputFiles(filePath);
  logger.debug({ filePath }, 'setInputFiles done');
}

async function waitForPreview(page: Page): Promise<void> {
  try {
    await waitForAny(page, SELECTORS.mediaPreviewReady, { timeout: 20_000 });
    logger.debug('media preview ready');
  } catch (err) {
    throw new Error(
      `media preview did not appear after upload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function typeCaption(page: Page, caption: string): Promise<void> {
  const input = await waitForAny(page, SELECTORS.captionInputOnPreview, { timeout: 8_000 });
  await input.click();
  await humanPause(page, [150, 400]);
  await input.pressSequentially(caption, { delay: 50 });

  const typed = (await input.textContent()) ?? '';
  if (typed.trim() !== caption.trim()) {
    logger.warn({ expected: caption, got: typed }, 'caption text mismatch');
    // No lanzamos error — el caption puede tener formatting interno.
    // Si es crítico para ti, cambia esto a throw.
  }
  logger.debug('caption typed');
}

async function sendFromPreview(page: Page): Promise<void> {
  try {
    const btn = await waitForAny(page, SELECTORS.previewSendButton, { timeout: 8_000 });
    await humanPause(page, [400, 900]);
    await btn.click();
    logger.debug('preview send button clicked');
  } catch (err) {
    // Fallback: Enter (en el preview modal, Enter también envía)
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'preview send button not found — falling back to Enter',
    );
    await page.keyboard.press('Enter');
  }

  // Esperar a que el dialog se cierre — indicativo de envío iniciado.
  await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 15_000 }).catch(() => {
    logger.warn('preview dialog did not close within 15s — may still be uploading');
  });
}

async function verifyLastMediaMessage(
  page: Page,
  route: AttachRoute,
  expectedCaption: string,
): Promise<boolean> {
  const bubbleSelectors =
    route === 'photosVideos'
      ? [...SELECTORS.lastMediaBubble.image, ...SELECTORS.lastMediaBubble.video]
      : SELECTORS.lastMediaBubble.document;

  try {
    await waitForAnyDynamic(page, bubbleSelectors, { timeout: 30_000 });
    logger.info({ route }, 'media bubble found in thread');

    // Verificación del caption (no bloqueante si falla — WA puede renderizar el caption en un span anidado)
    if (expectedCaption.length > 0) {
      try {
        const lastRow = page.locator('div[role="row"]').last();
        const text = await lastRow.innerText({ timeout: 3_000 });
        if (!text.includes(expectedCaption.trim())) {
          logger.warn({ expectedCaption, got: text }, 'caption not found in last row — soft warn');
        } else {
          logger.info('caption verified in last row');
        }
      } catch {
        logger.warn('could not read last row text for caption verification');
      }
    }

    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'no media bubble detected after send',
    );
    return false;
  }
}
```

### Importante: extraer funciones compartidas

Si `ensureChannelRow`, `navigateToChannel`, `dismissOnboardingOverlays` están privadas en `publish-text.ts`, extrae a `src/publisher/shared.ts`:

```typescript
// src/publisher/shared.ts
export { ensureChannelRow, navigateToChannel, dismissOnboardingOverlays } from './publish-text.js';
```

O mejor: mueve la implementación a `shared.ts` y en `publish-text.ts` haz `import { ... } from './shared.js'`. Así evitas dependencia circular.

---

<a id="m4"></a>
## Parche M4 — CLI `-m/--media`

Asumo que tu CLI actual (el que corre `npm run publish -- -c ... -t ...`) usa algún parser simple (args manuales, minimist, commander, etc.). Abajo va un ejemplo con parsing manual a imagen del que ya tienes.

### Ejemplo: `src/cli/publish.ts`

Añade soporte para `-m/--media` y llama a `publishMedia` cuando esté presente (con o sin `-t`):

```typescript
// Parseo argv — estilo simple, sin dependencia extra.
// Acepta: -c <canal> -t <texto> -m <path>
function parseArgs(argv: string[]): {
  channel: string;
  text?: string;
  media?: string;
} {
  const out: { channel?: string; text?: string; media?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '-c' || a === '--channel') && argv[i + 1]) out.channel = argv[++i];
    else if ((a === '-t' || a === '--text') && argv[i + 1]) out.text = argv[++i];
    else if ((a === '-m' || a === '--media') && argv[i + 1]) out.media = argv[++i];
  }
  if (!out.channel) throw new Error('missing --channel');
  if (!out.text && !out.media) throw new Error('need at least --text or --media');
  return out as { channel: string; text?: string; media?: string };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.media) {
    const { publishMedia } = await import('../publisher/publish-media.js');
    const result = await publishMedia({
      channelIdentifier: { name: args.channel },
      mediaPath: args.media,
      caption: args.text,
    });
    logger.info({ ...result }, 'publishMedia result');
    process.exit(result.success ? 0 : 1);
  }

  const { publishText } = await import('../publisher/publish-text.js');
  const result = await publishText({
    channelIdentifier: { name: args.channel },
    body: args.text!,
  });
  logger.info({ ...result }, 'publishText result');
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  logger.error({ err }, 'cli failed');
  process.exit(1);
});
```

### Uso

```bash
# Solo media (sin caption)
npm run publish -- -c "Pruebas n8n" -m /Users/kfran/Downloads/test.jpg

# Media + caption
npm run publish -- -c "Pruebas n8n" -m /Users/kfran/Downloads/test.jpg -t "Mira qué foto"

# Documento
npm run publish -- -c "Pruebas n8n" -m /Users/kfran/Downloads/info.pdf -t "Documento importante"

# Audio
npm run publish -- -c "Pruebas n8n" -m /Users/kfran/Downloads/demo.mp3

# Vídeo
npm run publish -- -c "Pruebas n8n" -m /Users/kfran/Downloads/clip.mp4 -t "Timelapse de hoy"
```

### Para tests rápidos

Genera archivos de prueba rápido:

```bash
# Imagen 1x1 PNG de 64 bytes
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x35\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82' > test-assets/pixel.png

# PDF mínimo
echo "%PDF-1.4
%test" > test-assets/mini.pdf

# MP3 vacío (no reproduce, pero sirve para test de ruta "Documento" para audio)
# Mejor descarga un mp3 real pequeño de libre uso.
```

---

<a id="m5"></a>
## Parche M5 — Verificación post-envío robusta

La verificación que viene en M3 (`verifyLastMediaMessage`) hace lo básico: buscar la burbuja con icono de media. Puntos a mejorar cuando lo tengas funcionando:

### Mejora V1: detectar confirmación de subida

Entre "click send" y "burbuja visible en hilo" pasan varios estados:

1. **Upload en progreso** — WA muestra un spinner sobre la burbuja
2. **Uploaded** — spinner desaparece
3. **Sent** (1 check) — `data-icon="msg-check"`
4. **Delivered** (2 checks) — `data-icon="msg-dblcheck"` (no aplica en canales, solo chats 1:1)

En canales el estado "delivered" no existe (los seguidores se marcan anónimamente). Nos basta con:

- Burbuja presente en hilo
- `data-icon="msg-check"` O ausencia de `data-icon="msg-time"` (que indica "aún enviándose")

```typescript
// Dentro de verifyLastMediaMessage, tras confirmar la burbuja:
const lastRow = page.locator('div[role="row"]').last();
const stillSending = await lastRow.locator('span[data-icon="msg-time"]').count();
if (stillSending > 0) {
  logger.warn('message still in msg-time state — upload may have stalled');
  // Opcional: esperar hasta N segundos a que pase a msg-check
  await lastRow.locator('span[data-icon="msg-check"]').waitFor({ timeout: 30_000 }).catch(() => {
    logger.warn('message did not transition to msg-check within 30s');
  });
}
```

### Mejora V2: verificar el nombre del archivo (solo para documentos)

En burbujas de documento, WA muestra el nombre del archivo. Puedes verificar:

```typescript
if (route === 'document') {
  const expectedName = basename(input.mediaPath);
  const lastRow = page.locator('div[role="row"]').last();
  const text = await lastRow.innerText().catch(() => '');
  if (!text.includes(expectedName)) {
    logger.warn({ expectedName, got: text }, 'document name not found in bubble');
  }
}
```

### Mejora V3: hash del archivo (paranoia)

Si quieres garantizar que el archivo que llega es el mismo que subiste (y no uno corrupto), puedes:

1. Calcular SHA256 del archivo local
2. En la burbuja, hacer click-derecho → Descargar, capturar el blob, hashearlo

No recomendado para PoC — complica el flujo. Solo si algún día un cliente sospecha de corrupción.

---

<a id="debug"></a>
## Debug: cómo dumpear el preview modal

Si el upload falla en el paso del preview (el preview no se muestra, o muestra algo que no esperabas), necesitas ver el DOM real. Truco:

### Opción A: dump condicional en la propia función

Temporalmente, justo antes del `sendFromPreview`, mete:

```typescript
await dumpDebugInfo(page, 'publish-media-preview-state');
```

Eso te deja el HTML + screenshot del estado del preview.

### Opción B: inspect manual con archivo precargado

Amplía tu CLI de inspect:

```typescript
// Ejemplo: `npm run inspect -- --preview /tmp/test.jpg`
// Abre WA Web, navega al canal, simula el flujo hasta justo ANTES del send,
// y espera a Ctrl+C para que inspecciones en DevTools.
```

Esto requiere código adicional en `src/cli/inspect.ts` — dime si lo quieres y lo detallo.

### Qué mirar en el dump del preview

- ¿Hay un `div[role="dialog"]` en el DOM? Si no, el modal no llegó a abrir.
- ¿El `input[type="file"]` sigue en el DOM con el blob asignado? `document.querySelectorAll('input[type=file]')` en DevTools y mira `.files`.
- ¿Aparece algún toast de error? WA a veces muestra "Archivo demasiado grande" (>100MB) o "Tipo no soportado".
- ¿Hay algún `aria-live` con mensaje de error?

---

<a id="limits"></a>
## Limitaciones conocidas

Cosas que NO cubre este parche y que vas a encontrarte antes o después:

1. **Multi-archivo**: subir 2+ archivos a la vez. El `setInputFiles` acepta array, pero el preview cambia (thumbnails en la parte inferior). Si lo necesitas, itera: un caption aplica al conjunto.
2. **Archivos >100MB**: WA Web los rechaza. Valida tamaño en `publishMedia` antes de intentar.
3. **Vídeos largos**: WA trocea o comprime. El preview puede tardar >10s en aparecer — sube el timeout de `waitForPreview` a 30s para vídeos grandes.
4. **Stickers**: van por ruta distinta (menú "Sticker" del attach, o copiar-pegar desde app móvil). No cubierto aquí.
5. **Documentos >64MB**: suelen fallar silenciosamente en WA Web (bug histórico). Si falla, el dump te lo dirá — no hay mucho que hacer salvo trocear.
6. **Nombre del archivo con caracteres especiales**: WA puede renombrarlo en el envío. La verificación V2 puede fallar; soft-warn, no throw.
7. **Audio como nota de voz**: lo que hace aquí es subir un archivo de audio como **documento**, no como **nota de voz**. Si necesitas nota de voz (waveform visible, auto-play tipo WhatsApp), la ruta es distinta (grabar via MediaRecorder API del navegador y postear por el endpoint interno). Mucho más frágil — no lo recomiendo.

---

## Checklist de aplicación

- [ ] **M1** Añadir/sustituir bloque de selectores de media en `selectors.ts`, subir `SELECTORS_VERSION` a `0.4.0`
- [ ] **M2** Crear `src/publisher/media-routing.ts`
- [ ] **M3** Extraer funciones compartidas a `src/publisher/shared.ts` (si aún no)
- [ ] **M3** Crear `src/publisher/publish-media.ts` con el código de arriba
- [ ] **M4** Actualizar CLI con soporte `-m/--media`
- [ ] `npm run build`
- [ ] Test imagen: `npm run publish -- -c "Pruebas n8n" -m ./test-assets/pixel.png -t "test img $(date +%s)"`
- [ ] Test documento: `npm run publish -- -c "Pruebas n8n" -m ./test-assets/mini.pdf -t "test pdf"`
- [ ] Test vídeo (con archivo real): `npm run publish -- -c "Pruebas n8n" -m ~/Videos/clip.mp4 -t "test video"`
- [ ] Test audio: `npm run publish -- -c "Pruebas n8n" -m ~/Music/demo.mp3`
- [ ] Test solo-media sin caption: `npm run publish -- -c "Pruebas n8n" -m ./test-assets/pixel.png`

## Si algo falla

El log te dirá exactamente en qué paso:

- `attach menu opened` OK → falló al encontrar opción del menú → P M1 `attachMenuOption`
- `attach route selected` OK → falló en `setInputFiles` → P M1 `fileInputImageVideo`/`fileInputDocument`
- `setInputFiles done` OK, no hay `media preview ready` → P M1 `mediaPreviewReady` o el archivo es inválido
- `media preview ready` OK, falla caption → P M1 `captionInputOnPreview`
- Caption OK, falla send → P M1 `previewSendButton`
- Send OK, no verifica → P M1 `lastMediaBubble.*`

Cada paso deja un `dumpDebugInfo` en `debug/` con screenshot + HTML si revienta.

/**
 * Publicación de media (imagen, vídeo, audio, documento) en un canal.
 *
 * ESTADO: skeleton. Implementación real se completa en Fase 3 del PoC Backlog.
 */
import type { Page } from 'playwright';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { launchBrowser, openContext, saveSession, sessionExists } from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import { logger } from '../logger.js';

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
  const browser = await launchBrowser();

  try {
    const context = await openContext(browser);
    const page = await context.newPage();
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SELECTORS.appReadyMarker, { timeout: 60_000 });

    await navigateToChannel(page, input.channelIdentifier);
    await attachMedia(page, input.mediaPath, input.mediaKind);
    if (input.body) await addCaption(page, input.body);
    await sendAndWait(page);

    await saveSession(context);
    return { success: true, durationMs: Date.now() - started, mediaSha256 };
  } catch (err) {
    logger.error({ err }, 'publishMedia failed');
    return {
      success: false,
      durationMs: Date.now() - started,
      mediaSha256,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser.close();
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

// --- Skeletons a completar durante el PoC ---

async function navigateToChannel(
  _page: Page,
  _channel: PublishMediaInput['channelIdentifier'],
): Promise<void> {
  throw new Error('navigateToChannel: not implemented — see PoC-BACKLOG Fase 3');
}

async function attachMedia(_page: Page, _path: string, _kind: MediaKind): Promise<void> {
  // TODO (PoC Fase 3 T3.1-T3.3):
  // - image/video: input en selectors.fileInputImageVideo (setInputFiles)
  // - document/audio: input en selectors.fileInputDocument
  // - esperar al preview
  throw new Error('attachMedia: not implemented — see PoC-BACKLOG Fase 3');
}

async function addCaption(_page: Page, _body: string): Promise<void> {
  // TODO (PoC Fase 3 T3.4): tipear en el caption del preview
  throw new Error('addCaption: not implemented — see PoC-BACKLOG Fase 3');
}

async function sendAndWait(_page: Page): Promise<void> {
  // TODO (PoC Fase 3 T3.5): click enviar + esperar mensaje en hilo + verificación SHA
  throw new Error('sendAndWait: not implemented — see PoC-BACKLOG Fase 3');
}

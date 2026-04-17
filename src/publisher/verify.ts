/**
 * Verificación post-envío.
 *
 * Después de enviar, leemos el último mensaje del canal y comprobamos que
 * coincide con lo que queríamos publicar. Detecta silent-fails.
 *
 * ESTADO: skeleton. Implementación real en Fase 4 del PoC Backlog.
 */
import type { Page } from 'playwright';
import { SELECTORS } from '../browser/selectors.js';

export interface VerifyInput {
  expectedText?: string;
  expectedMediaSha256?: string;
}

export interface VerifyResult {
  verified: boolean;
  reasons: string[];
}

export async function verifyLastMessage(
  page: Page,
  expected: VerifyInput,
): Promise<VerifyResult> {
  const reasons: string[] = [];
  // TODO (PoC Fase 4 T4.1):
  // 1. Localizar último mensaje del hilo (SELECTORS.lastMessageBubble)
  // 2. Comparar texto esperado con innerText del bubble
  // 3. Si hay media: descargarla desde el mensaje y comparar SHA-256
  // 4. Comprobar tick de envío (al menos "sent", no error)
  // Referencia: SELECTORS.lastMessageBubble
  void page;
  void expected;
  void SELECTORS.lastMessageBubble;
  reasons.push('verifyLastMessage not implemented — Fase 4 PoC Backlog');
  return { verified: false, reasons };
}

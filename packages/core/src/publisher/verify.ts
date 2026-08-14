/**
 * Verificación post-envío de contenido en el hilo del canal.
 *
 * WhatsApp Channels no siempre expone los ticks (msg-time/msg-check/…), así que
 * confirmar el envío por ticks da falsos negativos. Aquí verificamos el
 * CONTENIDO real: que el/los últimos items del hilo contienen el texto esperado
 * y/o media, además de usar los ticks como señal adicional cuando existen.
 */
import type { Page } from 'playwright';
import { SELECTORS } from '../browser/selectors.js';

/** Señales observadas tras pulsar Send (para auditoría). */
export interface VerificationObserved {
  previewClosed: boolean;
  sendClicked: boolean;
  indicatorAppeared: boolean;
  threadItemAppeared: boolean;
  textMatched: boolean | 'unknown';
  mediaDetected: boolean | 'unknown';
  uploadPendingCleared: boolean | 'unknown';
}

/** Normaliza texto para comparación tolerante (whitespace + invisibles). */
export function normalizeText(s: string): string {
  return s
    // Zero-width y marcas de dirección que WA suele inyectar.
    .replace(/[​-‏‪-‮﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿Alguno de los textos observados contiene (o está contenido en) el texto
 * esperado? Coincidencia tolerante: exacta, inclusión en cualquier dirección,
 * o coincidencia de un prefijo significativo (para captions largas que WA
 * pueda truncar/expandir con "ver más").
 */
export function textMatchesAny(expected: string, observedTexts: string[]): boolean {
  const exp = normalizeText(expected);
  if (!exp) return true;
  const prefix = exp.slice(0, Math.min(exp.length, 40));
  for (const raw of observedTexts) {
    const obs = normalizeText(raw);
    if (!obs) continue;
    if (obs === exp) return true;
    if (obs.includes(exp) || exp.includes(obs)) return true;
    if (prefix.length >= 8 && obs.includes(prefix)) return true;
  }
  return false;
}

/** Lee el texto de los últimos N items/burbujas del hilo. */
export async function findLastThreadTexts(page: Page, n = 4): Promise<string[]> {
  const bubbleSel = SELECTORS.lastMessageBubble.join(', ');
  const textSel = SELECTORS.messageText.join(', ');
  const out: string[] = [];
  try {
    const bubbles = page.locator(bubbleSel);
    const total = await bubbles.count().catch(() => 0);
    const from = Math.max(0, total - n);
    for (let i = from; i < total; i++) {
      const b = bubbles.nth(i);
      // Texto de los spans de mensaje o, en su defecto, innerText del bubble.
      let txt = '';
      const nodes = b.locator(textSel);
      const nc = await nodes.count().catch(() => 0);
      if (nc > 0) {
        const parts: string[] = [];
        for (let j = 0; j < nc; j += 1) {
          const part = (await nodes.nth(j).innerText({ timeout: 1500 }).catch(() => '')) ?? '';
          if (part) parts.push(part);
        }
        txt = parts.join('\n');
      }
      if (!txt) {
        txt = (await b.innerText({ timeout: 1500 }).catch(() => '')) ?? '';
      }
      if (txt) out.push(txt);
    }
  } catch {
    /* devolver lo que haya */
  }
  return out;
}

/**
 * Fallback amplio: lee texto visible de la página. En Channels el DOM de los
 * últimos items puede no entrar en nuestros selectores, pero el contenido sí
 * está visible en `body.innerText` tras publicar. Solo se usa como señal
 * post-send; no dispara retries.
 */
export async function findPageVisibleText(page: Page): Promise<string> {
  const inner = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) ?? '';
  const attrs = await page.evaluate(() => {
    const out: string[] = [];
    const selector = '[title], img[alt], [aria-label], [data-plain-text]';
    const doc = (globalThis as any).document;
    doc.querySelectorAll(selector).forEach((el: any) => {
      for (const attr of ['title', 'alt', 'aria-label', 'data-plain-text']) {
        const value = el.getAttribute(attr);
        if (value) out.push(value);
      }
    });
    return out.join('\n');
  }).catch(() => '');
  return `${inner}\n${attrs}`;
}

/**
 * ¿Hay media (img/video/canvas/blob) en los últimos items del hilo?
 * No dependemos de clases volátiles; buscamos elementos multimedia reales.
 * Devuelve true/false, o 'unknown' si no se pudo inspeccionar el hilo.
 */
export async function detectMediaInLastItems(page: Page, n = 4): Promise<boolean | 'unknown'> {
  const bubbleSel = SELECTORS.lastMessageBubble.join(', ');
  try {
    const bubbles = page.locator(bubbleSel);
    const total = await bubbles.count().catch(() => 0);
    if (total === 0) return 'unknown';
    const from = Math.max(0, total - n);
    // Lista editable desde la UI (ver comentario de threadMediaIndicator: la
    // anterior estaba hardcodeada aquí y contenía selectores muertos).
    const mediaSel = SELECTORS.threadMediaIndicator.join(', ');
    for (let i = from; i < total; i++) {
      const cnt = await bubbles.nth(i).locator(mediaSel).count().catch(() => 0);
      if (cnt > 0) return true;
    }
    return false;
  } catch {
    return 'unknown';
  }
}

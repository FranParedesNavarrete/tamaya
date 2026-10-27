/**
 * Estado del mensaje RECIÉN enviado en el hilo de un canal.
 *
 * Contar iconos de todo el hilo (ticks, relojes, errores) no sirve:
 *  - Un mensaje antiguo atascado (icono rojo + `ic-upload`) se queda para siempre
 *    en el hilo, así que "subida pendiente" nunca llega a 0 y el envío se daba por
 *    no confirmado aunque el post sí había salido.
 *  - El hilo está virtualizado (`data-virtualized="true"`, filas vacías): al
 *    entrar el mensaje nuevo, uno antiguo sale del DOM y la cuenta de ticks no
 *    sube aunque el tick nuevo exista.
 *
 * Por eso se apuntan los ids de las filas (`data-id`) antes de enviar y después
 * se leen los iconos SOLO de la fila que no estaba.
 */
import type { Page } from 'playwright';

export interface MessageStatus {
  failed: boolean;
  pending: boolean;
  delivered: boolean;
}

export interface RawMessageIcons {
  /** Textos de los `<svg><title>` de la fila (p. ej. `wds-ic-delivered`). */
  titles: string[];
  /** Valores de `data-icon` de la fila (familia antigua: `msg-time`, `msg-check`…). */
  dataIcons: string[];
  /** ¿Contiene el contenedor rojo de "Se produjo un error"? */
  hasFailContainer: boolean;
}

const PENDING_TITLES = new Set(['ic-upload', 'ic-schedule', 'wds-ic-pending', 'wds-ic-clock']);
const DELIVERED_TITLES = new Set(['wds-ic-delivered', 'wds-ic-read']);

/** Decisión pura sobre los iconos de una fila (sin navegador, fácil de probar). */
export function classifyMessageIcons(raw: RawMessageIcons): MessageStatus {
  const failed = raw.hasFailContainer
    || raw.titles.includes('ic-error')
    || raw.dataIcons.some((i) => i === 'msg-failed' || i === 'message-fail');
  const delivered = raw.titles.some((t) => DELIVERED_TITLES.has(t))
    || raw.dataIcons.some((i) => i === 'msg-check' || i === 'msg-dblcheck');
  const pending = raw.titles.some((t) => PENDING_TITLES.has(t)) || raw.dataIcons.includes('msg-time');
  return { failed, pending, delivered };
}

// El código que corre en el navegador va como cadena (igual que fileInputInventory):
// `core` no incluye la lib `dom`.
const ROOT_JS = (scopes: string[]) =>
  `(${JSON.stringify(scopes)}.map((s) => document.querySelector(s)).find(Boolean) || document)`;

/** `data-id` de todas las filas de mensaje que hay ahora mismo en el hilo. */
export async function snapshotMessageIds(page: Page, scopes: string[]): Promise<string[]> {
  const raw = await page.evaluate(
    `Array.from(${ROOT_JS(scopes)}.querySelectorAll('[data-testid^="conv-msg-"]'))
       .map((e) => e.getAttribute('data-id') || '').filter(Boolean)`,
  ).catch(() => []);
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/**
 * Estado de la última fila cuyo id no estaba en `known`. `null` si todavía no hay
 * ninguna fila nueva (o no se pudo leer el DOM).
 */
export async function readNewMessageStatus(
  page: Page,
  scopes: string[],
  known: string[],
): Promise<MessageStatus | null> {
  const raw = await page.evaluate(
    `(() => {
       const known = new Set(${JSON.stringify(known)});
       const rows = Array.from(${ROOT_JS(scopes)}.querySelectorAll('[data-testid^="conv-msg-"]'))
         .filter((e) => !known.has(e.getAttribute('data-id') || ''));
       const row = rows[rows.length - 1];
       if (!row) return null;
       return {
         titles: Array.from(row.querySelectorAll('svg > title')).map((t) => t.textContent || ''),
         dataIcons: Array.from(row.querySelectorAll('[data-icon]')).map((e) => e.getAttribute('data-icon') || ''),
         hasFailContainer: row.querySelector('[data-testid="fail-container"]') !== null,
       };
     })()`,
  ).catch(() => null);
  return raw ? classifyMessageIcons(raw as RawMessageIcons) : null;
}

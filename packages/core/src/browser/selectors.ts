/**
 * Selectores de WhatsApp Web centralizados.
 *
 * Los VALORES POR DEFECTO de los selectores editables (arrays estáticos) viven
 * ahora en `@tamaya/shared-types` (`EDITABLE_SELECTORS_DEFAULTS`), fuente única
 * de verdad compartida con `apps/api`. Aquí:
 *   - se reexponen esos defaults dentro del objeto `SELECTORS` (compatibilidad:
 *     el resto de `packages/core` sigue importando `SELECTORS.xxx` sin cambios),
 *   - se definen los selectores DINÁMICOS (funciones) que no se serializan y por
 *     tanto NO son editables como override,
 *   - se ofrece `applySelectorOverrides()` para mergear overrides encima de los
 *     defaults (con fallback a defaults) al arrancar el worker/control server.
 *
 * Los cambios de overrides requieren REINICIAR el proceso que consume selectores
 * (worker-publish / control-server): se aplican una sola vez al arranque.
 */
import {
  EDITABLE_SELECTORS_DEFAULTS,
  EDITABLE_SELECTOR_KEYS,
  cloneEditableSelectorDefaults,
  type EditableSelectorKey,
  type SelectorOverrides,
} from '@tamaya/shared-types';

/**
 * Fila de canal en la lista lateral. Selector DINÁMICO (no editable).
 *
 * OJO con el formato del aria-label: WhatsApp lo INVIRTIÓ. Antes era
 * "Canal <nombre>" (prefijo) y desde 2026-08 es "<nombre> Channel" (sufijo),
 * sobre un `div[role="button"][data-testid="newsletter-tab-newsletter-cell"]`.
 * Verificado con Playwright sobre dump real (2026-08-13). Se mantienen las
 * variantes antiguas como fallback.
 */
function channelRowByName(name: string): string[] {
  const escaped = name.replace(/"/g, '\\"');
  return [
    `div[role="button"][aria-label="${escaped} Channel"]`,
    `div[role="button"][aria-label="${escaped} Canal"]`,
    `div[role="button"][data-testid="newsletter-tab-newsletter-cell"][aria-label^="${escaped}"]`,
    `div[role="listitem"]:has(span[title="${escaped}"])`,
    `div[role="button"][aria-label="Canal ${escaped}"]`,
    `div[role="button"][aria-label="Channel ${escaped}"]`,
    `div[role="listitem"]:has-text("${escaped}")`,
  ];
}

/**
 * Composer de un canal específico. Selector DINÁMICO (no editable).
 * Doble verificación: si matchea, estás en el canal correcto.
 * El formato inglés "Type a message to <canal>" está verificado en dump real
 * (2026-08-13); se mantiene el español como fallback.
 */
function messageComposerForChannel(channelName: string): string[] {
  const escaped = channelName.replace(/"/g, '\\"');
  return [
    `div[contenteditable="true"][role="textbox"][aria-label="Type a message to ${escaped}"]`,
    `div[contenteditable="true"][role="textbox"][aria-label="Escribir un mensaje para ${escaped}"]`,
    `div[data-testid="conversation-compose-box-input"][aria-label*="${escaped}"]`,
  ];
}

/**
 * `SELECTORS` — objeto vivo consumido por los publishers.
 * Empieza con los defaults editables (copias mutables) + los dinámicos.
 * `applySelectorOverrides()` puede reemplazar in situ las claves editables.
 */
export const SELECTORS: Record<EditableSelectorKey, string[]> & {
  channelRowByName: (name: string) => string[];
  messageComposerForChannel: (channelName: string) => string[];
} = {
  ...cloneEditableSelectorDefaults(),
  channelRowByName,
  messageComposerForChannel,
};

/**
 * Aplica overrides sobre los selectores editables (merge con fallback a
 * defaults). Solo se aceptan claves editables conocidas; el resto se ignora.
 * Devuelve las claves efectivamente aplicadas.
 */
export function applySelectorOverrides(overrides: SelectorOverrides | null | undefined): EditableSelectorKey[] {
  const applied: EditableSelectorKey[] = [];
  if (!overrides || typeof overrides !== 'object') return applied;
  for (const key of EDITABLE_SELECTOR_KEYS) {
    const value = overrides[key];
    if (Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string' && s.length > 0)) {
      SELECTORS[key] = [...value];
      applied.push(key);
    }
  }
  return applied;
}

/** Restaura todos los selectores editables a sus defaults (in situ). */
export function resetSelectorsToDefaults(): void {
  const defaults = cloneEditableSelectorDefaults();
  for (const key of EDITABLE_SELECTOR_KEYS) {
    SELECTORS[key] = defaults[key];
  }
}

// Reexport útil para consumidores que quieran los defaults sin overrides.
export { EDITABLE_SELECTORS_DEFAULTS };

export const SELECTORS_VERSION = '0.5.0';

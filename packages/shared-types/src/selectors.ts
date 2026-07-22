import { z } from 'zod';

/**
 * Defaults de los selectores de WhatsApp Web que SON editables como override.
 *
 * Fuente única de verdad de los valores por defecto. Vive en shared-types
 * (paquete sin dependencias pesadas) para que lo consuman tanto:
 *   - `apps/api` (gateway que expone GET/PUT /settings/selectors), como
 *   - `packages/core` (que los usa para automatizar WhatsApp Web).
 *
 * IMPORTANTE:
 * - Cada entrada es un array de alternativas ordenadas por estabilidad. Los
 *   helpers de core (`waitForAny`) prueban uno a uno hasta acertar.
 * - Los selectores DINÁMICOS (`channelRowByName`, `messageComposerForChannel`)
 *   son funciones y NO se pueden serializar en BD → NO son editables. Se
 *   mantienen en `packages/core/src/browser/selectors.ts`.
 * - NO se eliminan defaults: los overrides de `app_settings` se mergean encima
 *   con fallback a estos valores.
 *
 * Última revisión de los valores: 2026-04-18 (verificado en dump real del DOM).
 */
export const EDITABLE_SELECTORS_DEFAULTS = {
  // --- App lifecycle ---
  // Marcador de "WA Web cargado y sesión activa" (pane lateral con la lista de chats).
  appReady: [
    '#pane-side',
    'div[aria-label="Lista de chats" i]',
    'div[aria-label="Chat list" i]',
    'header',
  ],
  // Canvas del QR de login.
  loginQrCanvas: [
    'canvas[aria-label*="Scan" i]',
    'canvas[aria-label*="Escanea" i]',
    'div[data-ref] canvas',
  ],

  // --- Navegación a canales ---
  channelsTab: [
    'button[aria-label="Canales"]',
    'button[aria-label="Channels"]',
    'div[role="button"][aria-label="Canales"]',
    'div[role="button"][aria-label="Channels"]',
  ],
  channelsTabActive: [
    'button[aria-pressed="true"][aria-label="Canales"]',
    'button[aria-pressed="true"][aria-label="Channels"]',
  ],
  channelsPanel: [
    'div[aria-label="Contenedor de la pestaña Canales"]',
    'div[aria-label*="Channels tab" i]',
  ],
  channelsList: [
    'div[aria-label="Lista de canales"]',
    'div[aria-label="Channel list"]',
    'div[role="grid"][aria-label*="canales" i]',
    'div[role="grid"][aria-label*="channels" i]',
  ],
  channelsSearchInput: [
    'div[aria-label*="Buscar canales" i][contenteditable="true"]',
    'div[aria-label*="Search channels" i][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"][aria-label*="canales" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="channels" i]',
  ],
  openChannelHeader: [
    'header',
  ],
  // Contador de seguidores — anchor fuerte de "canal abierto".
  openChannelSubscriberCount: [
    'span[aria-label$="seguidores"]',
    'span[aria-label$="seguidor"]',
    'span[aria-label$="followers"]',
    'span[aria-label$="follower"]',
  ],

  // --- Composer ---
  messageComposer: [
    'div[contenteditable="true"][role="textbox"][aria-label^="Escribir un mensaje"]',
    'div[contenteditable="true"][role="textbox"][aria-label^="Type a message"]',
    'div[contenteditable="true"][data-lexical-editor="true"][role="textbox"]',
    'footer div[contenteditable="true"][role="textbox"]',
  ],
  // Botón enviar. NO existe con composer vacío; aparece tras tipear.
  sendButton: [
    'div[role="button"][aria-label^="Send"]',
    'div[role="button"][aria-label^="Enviar"]',
    'button[aria-label^="Send"]',
    'button[aria-label^="Enviar"]',
    'button[aria-label="Send"]',
    'button[aria-label="Enviar"]',
    'div[role="button"][aria-label="Send"]',
    'div[role="button"][aria-label="Enviar"]',
    'span[data-icon="send"]',
    'span[data-icon="wds-ic-send-filled"]',
  ],
  micButton: [
    'span[data-icon="mic-outlined"]',
    'span[data-icon="ptt"]',
    'button[aria-label="Mensaje de voz"]',
    'button[aria-label="Voice message"]',
  ],

  // --- Overlay de onboarding del canal ---
  onboardingOverlay: [
    'div:has(> * > * > [aria-label="Cerrar"]):has-text("seguidores")',
  ],
  onboardingCloseButton: [
    'button[aria-label="Cerrar"]',
    'button[aria-label="Close"]',
    'div[role="button"][aria-label="Cerrar"]',
    'div[role="button"][aria-label="Close"]',
  ],

  // --- Adjuntar media ---
  attachButton: [
    'button[aria-label="Adjuntar"]',
    'button[aria-label="Attach"]',
    'div[title="Adjuntar"]',
    'div[title="Attach"]',
    'span[data-icon="plus"]',
    'span[data-icon="plus-rounded"]',
    'span[data-icon="clip"]',
  ],
  attachMenuPhotosVideos: [
    'button[role="menuitem"][aria-label="Photos & videos"]',
    'button[role="menuitem"][aria-label="Fotos y vídeos"]',
    'button[role="menuitem"][aria-label*="Photos" i]',
    'button[role="menuitem"][aria-label*="Fotos" i]',
  ],
  fileInputImageVideo: [
    'input[type="file"][accept*="image"][accept*="video"]',
    'input[type="file"][accept="*"][multiple]',
    'input[type="file"][multiple]',
  ],
  fileInputDocument: [
    'input[type="file"][accept="*"][multiple]',
    'input[type="file"][accept="*"]',
    'input[type="file"]:not([accept])',
  ],
  fileInputSticker: [
    'input[type="file"][accept="image/*"]:not([multiple])',
    'input[type="file"][accept="image/*"][accept*="sticker" i]',
  ],
  mediaPreviewReady: [
    'img[alt="Preview"][src^="blob:"]',
    'video[src^="blob:"]',
    'div[role="button"][aria-label="Send"]',
    'div[role="button"][aria-label="Enviar"]',
    'div[role="dialog"]:has(img[src^="blob:"])',
    'div[role="dialog"]:has(video)',
  ],
  stickerPreviewIndicator: [
    '[aria-label="Sticker"]',
    '[aria-label="Pegatina"]',
  ],
  captionInputOnPreview: [
    'div[contenteditable="true"][role="textbox"][aria-label="Type an update"]',
    'div[contenteditable="true"][role="textbox"][aria-label*="update" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="actualiza" i]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder="Type an update"]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="update" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="caption" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="leyenda" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="pie" i]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="leyenda" i]',
  ],

  // --- Mensajes en el hilo ---
  lastMessageBubble: [
    'div[role="row"]:last-of-type',
    'div.message-out:last-of-type',
    'div[data-pre-plain-text]:last-of-type',
  ],
  messageText: [
    'span.selectable-text[dir="ltr"]',
    'span.selectable-text[dir="auto"]',
    'span[data-testid="selectable-text"]',
  ],
  messageSentTick: [
    'span[data-icon="msg-check"]',
    'span[data-icon="msg-dblcheck"]',
    'span[data-icon="msg-time"]',
  ],
} as const;

/** Claves editables (todas las de arriba, valor array de strings). */
export type EditableSelectorKey = keyof typeof EDITABLE_SELECTORS_DEFAULTS;

export const EDITABLE_SELECTOR_KEYS = Object.keys(
  EDITABLE_SELECTORS_DEFAULTS,
) as EditableSelectorKey[];

/**
 * Claves NO editables: selectores dinámicos (funciones) que no se pueden
 * serializar. Mantienen siempre sus defaults en `packages/core`.
 */
export const NON_EDITABLE_SELECTOR_KEYS = [
  'channelRowByName',
  'messageComposerForChannel',
] as const;

/** Overrides de selectores tal y como se guardan en `app_settings`. */
export type SelectorOverrides = Partial<Record<EditableSelectorKey, string[]>>;

/**
 * Validación de overrides:
 *  - objeto JSON,
 *  - solo claves editables conocidas (rechaza desconocidas y las dinámicas),
 *  - cada valor: array NO vacío de strings NO vacíos.
 */
export const SelectorOverridesSchema = z.record(
  z.enum(EDITABLE_SELECTOR_KEYS as [EditableSelectorKey, ...EditableSelectorKey[]]),
  z.array(z.string().trim().min(1)).min(1),
);

/** Devuelve los defaults editables como objeto mutable (copias de los arrays). */
export function cloneEditableSelectorDefaults(): Record<EditableSelectorKey, string[]> {
  const out = {} as Record<EditableSelectorKey, string[]>;
  for (const key of EDITABLE_SELECTOR_KEYS) {
    out[key] = [...EDITABLE_SELECTORS_DEFAULTS[key]];
  }
  return out;
}

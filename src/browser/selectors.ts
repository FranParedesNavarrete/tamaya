/**
 * Selectores de WhatsApp Web centralizados.
 *
 * TODOS los selectores que toquen el DOM de WhatsApp Web deben vivir aquí.
 * Motivo: cuando WhatsApp Web cambia (pasa cada 2-4 meses), el hotfix consiste
 * en tocar UNA sola constante, no perseguir selectores por todo el código.
 *
 * Convenciones:
 * - Preferir role-based locators y aria-labels (más estables).
 * - Si hay que caer a CSS, documentar por qué en un comentario.
 * - Versionar cada grupo con fecha de última revisión.
 */

export const SELECTORS = {
  // --- Login / QR ---
  // Última revisión: 2026-04-17 (no verificado en vivo — skeleton del PoC)
  loginQrCanvas: 'canvas[aria-label*="Scan" i], canvas[aria-label*="Escanea" i]',
  // La barra lateral de chats aparece cuando la sesión está viva.
  appReadyMarker: 'div[role="grid"][aria-label*="chats" i], div[aria-label*="Chat list" i]',

  // --- Navegación a canales ---
  // WhatsApp Web separa canales en una pestaña "Actualizaciones" / "Channels".
  updatesTab: 'button[aria-label*="Updates" i], button[aria-label*="Actualizaciones" i]',

  // --- Composer (input de texto) ---
  // El composer es contenteditable, no un input. Importante para tipear.
  messageComposer:
    'div[contenteditable="true"][role="textbox"][aria-label*="message" i], div[contenteditable="true"][role="textbox"][aria-label*="mensaje" i]',

  // --- Adjuntar ficheros ---
  attachButton:
    'button[aria-label*="Attach" i], button[aria-label*="Adjuntar" i], div[aria-label*="Attach" i]',
  // Los <input type=file> reales. WhatsApp diferencia image/video vs. document.
  fileInputImageVideo: 'input[type="file"][accept*="image"], input[type="file"][accept*="video"]',
  fileInputDocument: 'input[type="file"]:not([accept*="image"]):not([accept*="video"])',

  // --- Botones de envío ---
  sendButton: 'button[aria-label*="Send" i], span[data-icon="send" i]',

  // --- Verificación post-envío ---
  // El último mensaje del hilo
  lastMessageBubble: 'div[data-id^="true_"]:last-of-type, [data-testid="msg-container"]:last-of-type',
} as const;

/** Semver de la versión de selectores. Subir cada vez que cambie WhatsApp Web. */
export const SELECTORS_VERSION = '0.1.0';

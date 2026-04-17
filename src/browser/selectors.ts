/**
 * Selectores de WhatsApp Web centralizados.
 *
 * TODOS los selectores que toquen el DOM de WhatsApp Web viven aquí.
 * Cuando WA Web cambie (pasa cada 2-4 meses), el hotfix consiste en tocar
 * UNA sola constante, no perseguir selectores por todo el código.
 *
 * Convenciones:
 * - Cada entrada es UN array de alternativas ordenadas por estabilidad deseada.
 *   Los helpers (`waitForAny`, `firstVisible`) prueban uno a uno hasta acertar.
 * - Preferir role-based / aria-label antes que CSS específico.
 * - Los aria-labels varían por idioma. Incluimos ES y EN al menos.
 * - Si añades un selector CSS específico, deja un comentario con la fecha
 *   de última verificación.
 *
 * Última revisión: 2026-04-17 (verificado en dump real del DOM)
 */

export const SELECTORS = {
  // --- App lifecycle ---
  /**
   * Marcador de "WA Web cargado y sesión activa".
   * Actualización 2026-04-17: los data-testid antiguos (chatlist-header) ya no existen.
   * Usamos el pane lateral con la lista de chats.
   */
  appReady: [
    '#pane-side',
    'div[aria-label="Lista de chats" i]',
    'div[aria-label="Chat list" i]',
    'header', // último recurso
  ],

  loginQrCanvas: [
    'canvas[aria-label*="Scan" i]',
    'canvas[aria-label*="Escanea" i]',
    'div[data-ref] canvas', // WA ha usado data-ref en el QR wrapper
  ],

  // --- Navegación a canales ---
  /**
   * Pestaña "Canales" en el navrail lateral.
   * Verificado 2026-04-17 en DOM real.
   */
  channelsTab: [
    'button[aria-label="Canales"]',
    'button[aria-label="Channels"]',
    'div[role="button"][aria-label="Canales"]',
    'div[role="button"][aria-label="Channels"]',
  ],

  /**
   * Confirma que estamos EN la pestaña Canales (aria-pressed="true").
   * Útil como idempotencia: no vuelves a clickar si ya estás.
   */
  channelsTabActive: [
    'button[aria-pressed="true"][aria-label="Canales"]',
    'button[aria-pressed="true"][aria-label="Channels"]',
  ],

  /**
   * Contenedor de la pestaña Canales cuando está abierta.
   */
  channelsPanel: [
    'div[aria-label="Contenedor de la pestaña Canales"]',
    'div[aria-label*="Channels tab" i]',
  ],

  /**
   * Lista scrollable de canales dentro del panel.
   */
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

  /**
   * Fila de canal en la lista lateral. El DOM real pone el aria-label
   * como "Canal <nombre>" en el elemento clickable.
   */
  channelRowByName: (name: string): string[] => {
    const escaped = name.replace(/"/g, '\\"');
    return [
      `div[role="button"][aria-label="Canal ${escaped}"]`,
      `div[role="button"][aria-label="Channel ${escaped}"]`,
      `div[role="listitem"]:has(span[title="${escaped}"])`,
      // Fallback por texto
      `div[role="listitem"]:has-text("${escaped}")`,
    ];
  },

  /**
   * Cabecera del canal abierto.
   * Actualización 2026-04-17: NO hay data-testid="conversation-header" en DOM real.
   * El único data-testid es "selectable-text". Usamos la etiqueta <header>
   * tal cual Y complementamos con el contador de seguidores como anchor.
   */
  openChannelHeader: [
    'header', // El <header> del conversation panel
  ],

  /**
   * Contador de seguidores — anchor FORTÍSIMO de "canal abierto".
   * aria-label dinámico: "N seguidores" / "N followers".
   * Si este elemento existe, el canal está abierto. Garantizado.
   */
  openChannelSubscriberCount: [
    'span[aria-label$="seguidores"]',
    'span[aria-label$="seguidor"]',  // singular: "1 seguidor"
    'span[aria-label$="followers"]',
    'span[aria-label$="follower"]',
  ],

  // --- Composer ---
  /**
   * Input del composer. Es un div contenteditable con Lexical Editor.
   * El aria-label es dinámico: "Escribir un mensaje para <nombre-canal>".
   * Verificado 2026-04-17.
   */
  messageComposer: [
    'div[contenteditable="true"][role="textbox"][aria-label^="Escribir un mensaje"]',
    'div[contenteditable="true"][role="textbox"][aria-label^="Type a message"]',
    'div[contenteditable="true"][data-lexical-editor="true"][role="textbox"]',
    'footer div[contenteditable="true"][role="textbox"]',
  ],

  /**
   * Generador para el composer DE UN CANAL ESPECÍFICO.
   * Útil como doble verificación: si este selector matchea, ESTÁS en el canal correcto.
   */
  messageComposerForChannel: (channelName: string): string[] => {
    const escaped = channelName.replace(/"/g, '\\"');
    return [
      `div[contenteditable="true"][role="textbox"][aria-label="Escribir un mensaje para ${escaped}"]`,
      `div[contenteditable="true"][role="textbox"][aria-label="Type a message to ${escaped}"]`,
    ];
  },

  /**
   * Botón enviar. IMPORTANTE: NO existe cuando el composer está vacío.
   * Aparece solo tras tipear el primer carácter. Si el composer está vacío,
   * WA Web renderiza `span[data-icon="mic-outlined"]` en su lugar.
   *
   * Uso: primero tipear, DESPUÉS esperar por este selector.
   */
  sendButton: [
    'button[aria-label="Enviar"]',
    'button[aria-label="Send"]',
    'span[data-icon="send"]',
    'span[data-icon="wds-ic-send-filled"]',
  ],

  /**
   * Cuando el composer está vacío, este icono está visible en lugar del send.
   * Útil como sanity check.
   */
  micButton: [
    'span[data-icon="mic-outlined"]',
    'span[data-icon="ptt"]',
    'button[aria-label="Mensaje de voz"]',
    'button[aria-label="Voice message"]',
  ],

  // --- Overlay de onboarding del canal ---
  /**
   * Panel flotante que WA muestra en canales nuevos ("Aumenta seguidores",
   * "Comparte el enlace"). Si aparece, puede tapar el composer.
   */
  onboardingOverlay: [
    'div:has(> * > * > [aria-label="Cerrar"]):has-text("seguidores")',
  ],

  /**
   * Botón cerrar del overlay.
   */
  onboardingCloseButton: [
    'button[aria-label="Cerrar"]',
    'button[aria-label="Close"]',
    'div[role="button"][aria-label="Cerrar"]',
    'div[role="button"][aria-label="Close"]',
  ],

  // --- Adjuntar media (sin cambios mayores — revisar en siguiente iteración) ---
  attachButton: [
    'button[aria-label="Adjuntar"]',
    'button[aria-label="Attach"]',
    'div[title="Adjuntar"]',
    'div[title="Attach"]',
    'span[data-icon="plus"]',
    'span[data-icon="plus-rounded"]',
    'span[data-icon="clip"]',
  ],

  fileInputImageVideo: [
    'input[type="file"][accept*="image"][accept*="video"]',
    'input[type="file"][accept*="image"]',
  ],

  fileInputDocument: [
    'input[type="file"][accept="*"]',
    'input[type="file"]:not([accept])',
  ],

  mediaPreviewReady: [
    'div[role="dialog"]:has(video), div[role="dialog"]:has(img)',
    'div:has(> div > canvas[class*="drawing"])', // WA a veces mete un canvas de anotación
  ],

  captionInputOnPreview: [
    'div[contenteditable="true"][role="textbox"][aria-label*="caption" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="leyenda" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="pie" i]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="leyenda" i]',
  ],

  // --- Mensajes en el hilo ---
  /**
   * Último mensaje del hilo. WA ya no usa data-testid="msg-container".
   * Usamos la estructura de filas role=row o la clase message-out (saliente).
   */
  lastMessageBubble: [
    'div[role="row"]:last-of-type',
    'div.message-out:last-of-type',
    'div[data-pre-plain-text]:last-of-type',
  ],

  messageText: [
    'span.selectable-text[dir="ltr"]',
    'span.selectable-text[dir="auto"]',
    'span[data-testid="selectable-text"]', // el único data-testid que sí existe
  ],

  messageSentTick: [
    'span[data-icon="msg-check"]',
    'span[data-icon="msg-dblcheck"]',
    'span[data-icon="msg-time"]',
  ],
} as const;

export const SELECTORS_VERSION = '0.3.0';

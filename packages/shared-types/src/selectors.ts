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
 * Última revisión de los valores: 2026-08-13 (verificado con Playwright contra
 * dump real del DOM con canal abierto; UI en inglés, stack Comet/StyleX).
 *
 * Cambios de 2026-08-13 (WhatsApp Web rehizo parte del DOM):
 * - Los `data-testid` volvieron y son el anchor más estable (`newsletter-tab-drawer`,
 *   `conversation-compose-box-input`, `conversation-header`, `chat-subtitle`,
 *   `conversation-panel-messages`, `conv-msg-*`). Van primeros.
 * - El buscador de canales ya NO es un `div[contenteditable]`: es un
 *   `<input type="text" role="textbox" aria-label="Search">`.
 * - Los ticks de mensaje ya NO usan `data-icon="msg-*"`: ahora son
 *   `<svg><title>wds-ic-delivered|wds-ic-read</title>`.
 * - El panel de canales cambió de aria-label a "Channel tab drawer".
 * - Los `id` de React (`_r_bj_`) cambian en cada render: NUNCA usarlos.
 *
 * Cambios de 2026-08-14 (verificado contra dumps reales en inglés Y español):
 * - Nuevas claves `blockingDialog` / `blockingDialogDismiss`: WA abre modales al
 *   entrar ("What's new on WhatsApp Web") que interceptan TODOS los clicks. El
 *   síntoma es un timeout que parece selector roto; ver `browser/dialogs.ts`.
 * - `channelsTab` ya no usa `data-navbar-item-index`: el índice se reordena y el
 *   3 es Communities, no Channels. Se ancla al icono `wds-ic-channels`.
 * - Los selectores en español estaban ya cubiertos (`Canales`, `Buscar`,
 *   `Canal <nombre>`); el idioma NO era la causa de los fallos.
 * - Selectores de Estadísticas del canal (`insights*`) para la lectura de
 *   métricas; ver `metrics/channel-insights.ts`.
 */
export const EDITABLE_SELECTORS_DEFAULTS = {
  // --- App lifecycle ---
  // Marcador de "WA Web cargado y sesión activa" (pane lateral con la lista de chats).
  appReady: [
    '#pane-side',
    'div[data-testid="wa-web-main-screen"]',
    '#side',
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
  /**
   * Diálogos modales globales que WA Web abre nada más entrar: "What's new on
   * WhatsApp Web", onboarding, avisos de descarga de la app, permisos…
   *
   * Bloquean TODO: llevan `aria-modal="true"` + backdrop
   * (`div[data-animate-modal-backdrop]`), así que cualquier click posterior
   * falla con "element intercepts pointer events" aunque el selector destino
   * sea correcto. Hay que cerrarlos antes de navegar.
   *
   * CUIDADO: el preview de media TAMBIÉN es `role="dialog"`. Los candidatos
   * genéricos excluyen los diálogos que contienen blob (imagen/vídeo cargados)
   * para no cerrar el preview antes de pulsar Send.
   */
  blockingDialog: [
    'div[data-testid="confirm-popup"] div[role="dialog"][aria-modal="true"]',
    'div[role="dialog"]:has(div[data-testid="popup-contents"])',
    'div[role="dialog"][aria-modal="true"]:not(:has(img[src^="blob:"])):not(:has(video[src^="blob:"]))',
    'div[role="alertdialog"]',
  ],
  /**
   * Botones que cierran esos diálogos, por orden de preferencia: primero el
   * aspa (no acepta nada), luego los "continuar / entendido" por texto exacto.
   * Se buscan SIEMPRE scopeados dentro del diálogo.
   */
  blockingDialogDismiss: [
    'button[aria-label="Close"]',
    'button[aria-label="Cerrar"]',
    'div[role="button"][aria-label="Close"]',
    'div[role="button"][aria-label="Cerrar"]',
    'span[data-icon="x"]',
    'span[data-icon="x-alt"]',
    'button:has(svg > title:text-is("ic-close"))',
    'button:has(span:text-is("Continue"))',
    'button:has(span:text-is("Continuar"))',
    'button:has(span:text-is("OK"))',
    'button:has(span:text-is("Got it"))',
    'button:has(span:text-is("Entendido"))',
    'button:has(span:text-is("Not now"))',
    'button:has(span:text-is("Ahora no"))',
  ],

  // --- Navegación a canales ---
  channelsTab: [
    'button[aria-label="Channels"]',
    'button[aria-label="Canales"]',
    // Anchors por icono: sobreviven a cambios de idioma Y de posición.
    // El icono actual es wds-ic-channels; newsletter-tab es el histórico.
    'button:has(svg > title:text-is("wds-ic-channels"))',
    'button:has(span[data-icon="newsletter-tab"])',
    'button:has(> div svg > title:text-is("newsletter-tab"))',
    // NO usar data-navbar-item-index a secas: el índice se reordena. En el DOM
    // de 2026-08-14 Channels es el 2 y el 3 es Communities, así que un
    // índice equivocado abre otra pestaña en silencio. Se exige el icono.
    'button[data-navbar-item="true"]:has(svg > title:text-is("wds-ic-channels"))',
    'div[role="button"][aria-label="Canales"]',
    'div[role="button"][aria-label="Channels"]',
  ],
  channelsTabActive: [
    'button[aria-pressed="true"][aria-label="Channels"]',
    'button[aria-pressed="true"][aria-label="Canales"]',
    'button[aria-pressed="true"]:has(svg > title:text-is("wds-ic-channels"))',
    'button[aria-pressed="true"]:has(span[data-icon="newsletter-tab"])',
  ],
  channelsPanel: [
    'div[data-testid="newsletter-tab-drawer"]',
    'div[aria-label*="Channel tab" i]',
    'div[aria-label="Contenedor de la pestaña Canales"]',
    'div[aria-label*="Channels tab" i]',
  ],
  channelsList: [
    'div[aria-label*="Channel list" i]',
    'div[role="navigation"][aria-label*="Channel list" i]',
    'div[aria-label*="Lista de canales" i]',
    'div[role="grid"][aria-label*="canales" i]',
    'div[role="grid"][aria-label*="channels" i]',
  ],
  // OJO: desde 2026-08 es un <input type="text"> nativo, no un contenteditable.
  // Va scopeado al drawer de canales para no capturar el buscador de chats
  // ("Search or start a new chat"), que vive en el panel de la izquierda.
  channelsSearchInput: [
    'div[data-testid="newsletter-tab-drawer"] input[type="text"][role="textbox"]',
    'div[data-testid="newsletter-tab-drawer"] input[type="text"]',
    'div[data-testid="newsletter-tab-drawer"] input[role="textbox"][aria-label*="Search" i]',
    'div[data-testid="newsletter-tab-drawer"] input[role="textbox"][aria-label*="Buscar" i]',
    'div[aria-label*="Channel tab" i] input[type="text"]',
    'div[aria-label*="Buscar canales" i][contenteditable="true"]',
    'div[aria-label*="Search channels" i][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"][aria-label*="canales" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="channels" i]',
  ],
  openChannelHeader: [
    'header[data-testid="conversation-header"]',
    'header',
  ],
  // Contador de seguidores — anchor fuerte de "canal abierto".
  openChannelSubscriberCount: [
    'div[data-testid="chat-subtitle"] span[aria-label$="follower"]',
    'div[data-testid="chat-subtitle"] span[aria-label$="followers"]',
    'div[data-testid="chat-subtitle"] span[aria-label$="seguidor"]',
    'div[data-testid="chat-subtitle"] span[aria-label$="seguidores"]',
    'span[aria-label$="seguidores"]',
    'span[aria-label$="seguidor"]',
    'span[aria-label$="followers"]',
    'span[aria-label$="follower"]',
  ],

  // --- Composer ---
  messageComposer: [
    'div[data-testid="conversation-compose-box-input"]',
    'div[contenteditable="true"][role="textbox"][aria-label^="Type a message"]',
    'div[contenteditable="true"][role="textbox"][aria-label^="Escribir un mensaje"]',
    'div[contenteditable="true"][data-lexical-editor="true"][role="textbox"]',
    'footer div[contenteditable="true"][role="textbox"]',
  ],
  // Botón enviar. NO existe con composer vacío; aparece tras tipear.
  // El aria-label puede llevar sufijo dinámico ("Send 1 selected") ⇒ prefix-match.
  sendButton: [
    'div[role="button"][aria-label^="Send"]',
    'div[role="button"][aria-label^="Enviar"]',
    'button[aria-label^="Send"]',
    'button[aria-label^="Enviar"]',
    'span[data-icon="wds-ic-send-filled"]',
    'span[data-icon="send"]',
    // WA está migrando de data-icon a <svg><title>wds-ic-…</title>.
    'span:has(> svg > title:text-is("wds-ic-send-filled"))',
    'span:has(> svg > title:text-is("send"))',
  ],
  micButton: [
    'span[data-icon="mic-outlined"]',
    'button[aria-label="Voice message"]',
    'button[aria-label="Mensaje de voz"]',
    'span[data-icon="ptt"]',
    'span:has(> svg > title:text-is("mic-outlined"))',
  ],

  // --- Overlay de onboarding del canal ---
  onboardingOverlay: [
    'div:has(> * > * > [aria-label="Close"]):has-text("follower")',
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
    'button[aria-label="Attach"]',
    'button[aria-label="Adjuntar"]',
    'span[data-icon="plus-rounded"]',
    'button[aria-haspopup="menu"][aria-label*="Attach" i]',
    'button[aria-haspopup="menu"][aria-label*="Adjuntar" i]',
    'div[title="Adjuntar"]',
    'div[title="Attach"]',
    'span[data-icon="plus"]',
    'span[data-icon="clip"]',
    'span:has(> svg > title:text-is("plus-rounded"))',
  ],
  // El menú de adjuntos solo existe tras clicar "+", así que estos selectores
  // no se pueden verificar en un dump en reposo: se mantienen anchos a propósito.
  attachMenuPhotosVideos: [
    '[role="menuitem"][aria-label*="Photos" i]',
    '[role="menuitem"][aria-label*="Fotos" i]',
    'button[role="menuitem"][aria-label="Photos & videos"]',
    'button[role="menuitem"][aria-label="Fotos y vídeos"]',
    'li[role="menuitem"]:has-text("Photos & videos")',
    'li[role="menuitem"]:has-text("Fotos y vídeos")',
    '[role="menuitem"]:has-text("Photos & videos")',
    '[role="menuitem"]:has-text("Fotos y vídeos")',
    '[role="button"][aria-label*="Photos & videos" i]',
    '[aria-label*="Photos & videos" i]',
  ],
  // El input de imagen+vídeo se crea al abrir el menú de adjuntos. En reposo el
  // único input del DOM es `accept="image/*"` sin `multiple` (= el de sticker),
  // por eso el candidato permisivo va ÚLTIMO: si cae ahí, `assertNotStickerPreview`
  // aborta antes de enviar en lugar de publicar una pegatina.
  fileInputImageVideo: [
    'input[type="file"][accept*="image"][accept*="video"]',
    'input[type="file"][accept="*"][multiple]',
    'input[type="file"][multiple]',
    'input[type="file"][accept*="video"]',
    'input[type="file"][accept*="image"]',
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
    // Anclas por data-testid del editor de media: no dependen del idioma y son
    // específicas del preview. Verificadas contra el DOM real (2026-08-14).
    'div[data-testid="media-editor-canvas"]',
    'div[data-testid="media-caption-input-container"]',
    'img[alt="Preview"][src^="blob:"]',
    // El alt está traducido: en español es "Vista previa".
    'img[alt="Vista previa"][src^="blob:"]',
    'video[src^="blob:"]',
    // Caja de caption del preview (excluyendo el composer del canal, ver abajo).
    'div[contenteditable="true"][role="textbox"][aria-placeholder="Type an update"]:not([aria-label^="Type a message"]):not([aria-label^="Escribir un mensaje"])',
    // Misma caja de caption con la UI en español.
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="actualiza" i]:not([aria-label^="Type a message"]):not([aria-label^="Escribir un mensaje"])',
    'div[role="button"][aria-label^="Send"]',
    'div[role="button"][aria-label^="Enviar"]',
    'button[aria-label^="Send"]',
    'button[aria-label^="Enviar"]',
    'div[role="dialog"]:has(img[src^="blob:"])',
    'div[role="dialog"]:has(video)',
  ],
  /**
   * Señales de que el preview abierto es el EDITOR DE PEGATINAS y no el de
   * foto/vídeo.
   *
   * CUIDADO: `[aria-label="Sticker"]` a secas ya NO sirve. La barra de
   * herramientas del preview normal incluye un botón "Sticker"
   * (`data-testid="sticker-button"`, aria-label="Sticker"), así que ese selector
   * matchea en un preview de foto perfectamente correcto y daría un falso
   * "adjuntado como pegatina". Hay que exigir señales exclusivas del modo
   * pegatina: el recorte de contorno o un contenedor rotulado como tal.
   */
  stickerPreviewIndicator: [
    'button[aria-label="Add outline"]',
    'button[aria-label="Añadir contorno"]',
    '[role="dialog"][aria-label*="sticker" i]',
    '[role="dialog"][aria-label*="pegatina" i]',
  ],
  /**
   * Caja de caption del preview de media.
   *
   * CUIDADO — colisión real: el composer normal del canal lleva
   * `aria-placeholder="Type an update"` junto a `aria-label="Type a message to <canal>"`.
   * Los selectores por `aria-placeholder` sin filtrar matcheaban ese composer,
   * con dos consecuencias: (a) el caption podía escribirse en la caja del canal
   * en vez de en el preview, y (b) `assertNotStickerPreview` creía siempre que
   * había preview normal y nunca detectaba el modo pegatina.
   * Por eso todas las variantes por placeholder excluyen el composer del canal.
   */
  captionInputOnPreview: [
    // Ancla real, verificada contra el DOM del preview (2026-08-14): la caja de
    // caption lleva data-testid propio y NO depende del idioma. Va primera.
    'div[data-testid="media-caption-input-container"]',
    // Estructural, por si quitan el testid: el contenteditable que vive en el
    // mismo contenedor que el lienzo del editor. OJO: el preview NO es un
    // role="dialog" (comprobado), así que no se puede scopear por ahí.
    'div:has(div[data-testid="media-editor-canvas"]) div[contenteditable="true"][role="textbox"]',
    // Etiquetas reales por idioma. En español es "Escribe algo" — NO "actualiza"
    // ni "leyenda": eso lo supuse y era falso.
    'div[contenteditable="true"][role="textbox"][aria-label="Escribe algo"]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder="Escribe algo"]',
    'div[contenteditable="true"][role="textbox"][aria-label="Type an update"]',
    'div[contenteditable="true"][role="textbox"][aria-label*="update" i]:not([aria-label^="Type a message"])',
    'div[contenteditable="true"][role="textbox"][aria-label*="actualiza" i]:not([aria-label^="Escribir un mensaje"])',
    'div[contenteditable="true"][role="textbox"][aria-placeholder="Type an update"]:not([aria-label^="Type a message"]):not([aria-label^="Escribir un mensaje"])',
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="update" i]:not([aria-label^="Type a message"]):not([aria-label^="Escribir un mensaje"])',
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="actualiza" i]:not([aria-label^="Type a message"]):not([aria-label^="Escribir un mensaje"])',
    'div[contenteditable="true"][role="textbox"][aria-label*="caption" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="leyenda" i]',
    'div[contenteditable="true"][role="textbox"][aria-label*="pie" i]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder*="leyenda" i]',
  ],

  // --- Estadísticas del canal (drawer "Estadísticas", solo admin) ---
  // Verificado contra dump real (UI en español, 2026-08-14). Los data-testid de
  // este panel son estables y en inglés aunque la UI esté traducida, así que van
  // primeros; los fallbacks por `title` cubren es/en si Meta los quitara.
  insightsDrawer: [
    'div[data-testid="newsletter-insights-drawer"]',
    'div:has(> header [data-testid="drawer-title-body"] h2:text-is("Estadísticas"))',
    'div:has(> header [data-testid="drawer-title-body"] h2:text-is("Insights"))',
  ],
  insightsTabReach: [
    'button[data-testid="newsletter-insights-tab-reach"]',
    'button[role="tab"][title="Alcance"]',
    'button[role="tab"][title="Reach"]',
  ],
  insightsTabGrowth: [
    'button[data-testid="newsletter-insights-tab-growth"]',
    'button[role="tab"][title="Crecimiento"]',
    'button[role="tab"][title="Growth"]',
  ],
  insightsTabFollowers: [
    'button[data-testid="newsletter-insights-tab-followers"]',
    'button[role="tab"][title="Seguidores"]',
    'button[role="tab"][title="Followers"]',
  ],
  // Rango de fechas del panel ("Últimos 30 días" + "14 jul. - 12 ago.").
  // No tiene testid: se ancla al icono de calendario y se sube al contenedor.
  insightsDateRangeRow: [
    'div:has(> span > svg > title:text-is("ic-calendar-month"))',
    'div:has(> span[data-icon="calendar-month"])',
  ],
  // Total de "Cuentas alcanzadas". Este SÍ viene sin abreviar.
  insightsReachTotal: [
    'div[data-testid="newsletter-admin-insights-reach-widget-count"]',
  ],
  // Filas de la leyenda del donut: "Seguidores" / "No seguidores".
  insightsReachLegendItem: [
    'div[data-testid^="newsletter-reach-widget-legend-item-"]',
  ],
  insightsLegendCount: ['div[data-testid="reach-widget-count"]'],
  insightsLegendDelta: ['div[data-testid="reach-widget-delta"]'],
  // Barras de "Principales regiones" (y de cualquier otro bar-chart del panel).
  insightsBarChartRow: ['div[data-testid^="bar-chart-row-"]'],
  insightsBarLabel: ['div[data-testid="label"]'],
  insightsBarValue: ['div[data-testid="value"]'],
  insightsBarPercent: ['div[data-testid="percentage"]'],

  // --- Mensajes en el hilo ---
  lastMessageBubble: [
    'div[data-testid="conversation-panel-messages"] div[data-testid^="conv-msg-"]',
    'div[data-testid^="conv-msg-"]',
    'div[data-testid="conversation-panel-messages"] div[role="row"]',
    'div[role="row"]:last-of-type',
    'div[data-pre-plain-text]:last-of-type',
    'div.message-out:last-of-type',
  ],
  /**
   * Señales de que una burbuja del hilo contiene MEDIA (no solo texto).
   *
   * Verificado contra dump real con fotos publicadas (2026-08-14):
   * - `img[src*="/media/"]` daba 0 hits y era dead code: las imágenes servidas
   *   por WhatsApp vienen de `media-mad1-1.cdn.whatsapp.net/v/t61…`, donde no
   *   hay ningún `/media/` entre barras. Por eso `mediaDetected` salía false en
   *   publicaciones que SÍ tenían imagen.
   * - `image-thumb` y `media-url-provider` aciertan en el 100% de las burbujas
   *   con foto y no dependen del idioma.
   *
   * DOS FALSOS POSITIVOS QUE HAY QUE EVITAR:
   * - `img[src^="data:image"]`: los emojis del hilo son sprites data:image/gif,
   *   así que cualquier mensaje con un emoji contaría como media.
   * - `img[src*="whatsapp.net"]` a secas: las fotos de perfil son
   *   `pps.whatsapp.net` y en grupos aparecen DENTRO de la fila del mensaje.
   *   Por eso se exige `cdn.whatsapp.net`, que es solo media.
   */
  threadMediaIndicator: [
    '[data-testid="image-thumb"]',
    '[data-testid="media-url-provider"]',
    'img[src^="blob:"]',
    'img[src*="cdn.whatsapp.net"]',
    'video',
    'canvas',
    'div[style*="blob:"]',
    'span[data-icon="media-download"]',
    'span[data-icon="audio-play"]',
    // Fallbacks por idioma, al final: en español la burbuja de foto expone
    // aria-label="Abrir foto". Redundantes con image-thumb, pero inofensivos
    // (solo aparecen en burbujas con media) y cubren que Meta quite el testid.
    'div[aria-label="Abrir foto"]',
    'div[aria-label="Open photo"]',
    'div[aria-label="Abrir vídeo"]',
    'div[aria-label="Open video"]',
  ],
  messageText: [
    'span[data-testid="selectable-text"]',
    'span.selectable-text[dir="ltr"]',
    'span.selectable-text[dir="auto"]',
  ],
  // Desde 2026-08 los ticks son <svg><title>wds-ic-delivered|wds-ic-read</title>.
  // OJO: `span[aria-label*="Sent" i]` a secas es un FALSO POSITIVO — matchea el
  // aviso "New messages will disappear … after they're sent"; hay que exigir svg.
  messageSentTick: [
    'div[data-testid="conversation-panel-messages"] span:has(> svg > title:text-is("wds-ic-delivered"))',
    'div[data-testid="conversation-panel-messages"] span:has(> svg > title:text-is("wds-ic-read"))',
    'span[aria-label*="Sent" i]:has(> svg > title)',
    'span[aria-label*="Read" i]:has(> svg > title)',
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

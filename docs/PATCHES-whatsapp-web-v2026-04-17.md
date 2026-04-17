# Tamaya — Parches de corrección v2026-04-17

Documento de análisis del dump `debug/2026-04-17T20-29-15-402Z_publish-text-fail.html` y los 5 parches para aplicar a mano. Cada parche es autónomo — puedes aplicarlos en cualquier orden, pero el orden recomendado está indicado.

**Autor**: Fran
**Fecha de análisis**: 2026-04-17
**Versión de WhatsApp Web analizada**: la del dump (DOM sin `data-testid` salvo `selectable-text`)
**Archivos afectados**: `src/browser/session.ts`, `src/config.ts`, `src/browser/selectors.ts`, `src/publisher/publish-text.ts`, `src/publisher/login.ts`, `src/publisher/publish-media.ts`, `src/cli/inspect.ts`, `.env.example`

---

## Tabla de contenidos

1. [Parche 1 — Fix QR persistente: `launchPersistentContext` con `userDataDir`](#parche-1)
2. [Parche 2 — Selectores reales del DOM actual de WA Web](#parche-2)
3. [Parche 3 — `confirmChannelOpen` tolerante (composer como anchor)](#parche-3)
4. [Parche 4 — Orden correcto en `typeAndSend` (tipear → buscar send)](#parche-4)
5. [Parche 5 — Cerrar overlay de onboarding antes de tipear](#parche-5)
6. [Extras opcionales](#extras)

---

## Resumen de hallazgos del dump

Leyendo el HTML (~1.1MB) y el screenshot de la run de las 22:29, se confirma:

| Hecho | Evidencia |
|---|---|
| El canal "Pruebas n8n" **sí se abrió** correctamente | Screenshot: header con nombre + "9 seguidores" + composer "Escribe algo" |
| El único `data-testid` en TODO el DOM es `selectable-text` | `grep data-testid` sobre el dump: 1 valor único |
| El composer usa Lexical Editor (no un input tradicional) | `data-lexical-editor="true"` + `contenteditable="true"` + `role="textbox"` |
| El composer tiene `aria-label` **dinámico con el nombre del canal** | `aria-label="Escribir un mensaje para Pruebas n8n"` |
| Cuando el composer está vacío, **no hay botón enviar** | En su lugar: `<span data-icon="mic-outlined">` (mensaje de voz) |
| Hay un overlay de onboarding ("Aumenta seguidores", "Comparte enlace") | Panel flotante visible en el screenshot que bloquea partes del UI |
| La cabecera del canal abierto es un `<header>` **sin id/testid** | Solo clases CSS generadas |
| El contador de seguidores tiene aria-label estable | `span[aria-label="9 seguidores"][title="9 seguidores"]` — anchor de confirmación oro |
| `storageState` no persiste IndexedDB | Por eso vuelve a pedir QR cada run — WA guarda tokens en IDB |

---

<a id="parche-1"></a>
## Parche 1 — Fix QR persistente: `launchPersistentContext` con `userDataDir`

### Problema

Cada vez que ejecutas `npm run publish` se abre el navegador y pide escanear QR de nuevo, aunque ya hiciste `npm run login` con éxito.

### Causa raíz

WhatsApp Web guarda los tokens de sesión en **IndexedDB** (no en `localStorage` ni cookies). El método actual usa `context.storageState({ path })` que solo persiste:

- cookies
- localStorage
- sessionStorage

Pero NO IndexedDB. Resultado: al abrir el siguiente contexto con `storageState`, WA Web no encuentra su token de sesión y muestra QR.

### Solución

Usar `chromium.launchPersistentContext(userDataDir, options)` que guarda el **perfil completo de Chromium** (incluyendo IndexedDB) en un directorio.

Esto cambia el modelo: ya no hay "launch browser + new context con storageState". En su lugar, hay un solo paso: "launch persistent context apuntando a un directorio". El contexto persiste TODO lo que guarde el navegador.

### Archivos a cambiar

#### `src/config.ts`

Renombrar `sessionPath` (archivo JSON) → `userDataDir` (directorio).

```diff
 const configSchema = z.object({
   tenantId: z.string().min(1),
-  sessionPath: z.string().min(1),
+  userDataDir: z.string().min(1),
   // ... resto igual
 });

 export const config: Config = configSchema.parse({
   tenantId: process.env.TAMAYA_TENANT_ID ?? 'default',
-  sessionPath: process.env.TAMAYA_SESSION_PATH ?? './sessions/default.json',
+  userDataDir: process.env.TAMAYA_USER_DATA_DIR ?? './sessions/default-profile',
   // ... resto igual
 });
```

#### `.env.example`

```diff
-TAMAYA_SESSION_PATH=./sessions/default.json
+# Directorio donde Chromium persiste el perfil completo (IndexedDB incluido).
+# WhatsApp Web guarda sus tokens de sesión en IndexedDB, por eso necesitamos
+# persistir el perfil entero, no solo storageState.
+TAMAYA_USER_DATA_DIR=./sessions/default-profile
```

#### `src/browser/session.ts`

Reescribe el archivo. La nueva API es más simple — no hay `launchBrowser` + `openContext` por separado; todo es `launchPersistentContextForTenant`.

```typescript
/**
 * Gestión de contexto persistente de WhatsApp Web.
 *
 * Usamos `launchPersistentContext` (no `launch` + `newContext`) porque
 * WhatsApp Web guarda sus tokens en IndexedDB, que storageState NO captura.
 * El perfil persistente guarda el userDataDir completo de Chromium.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getBrowserContextOptions } from './fingerprint.js';

export async function launchPersistentContextForTenant(): Promise<BrowserContext> {
  mkdirSync(config.userDataDir, { recursive: true });

  const options = getBrowserContextOptions();
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.playwright.headless,
    slowMo: config.playwright.slowMoMs,
    args: ['--disable-blink-features=AutomationControlled'],
    // Fingerprint coherente por tenant (viewport, locale, timezone, UA)
    viewport: options.viewport,
    locale: options.locale,
    timezoneId: options.timezoneId,
    userAgent: options.userAgent,
  });

  logger.info({ userDataDir: config.userDataDir }, 'persistent context opened');
  return context;
}

/**
 * Heurística: consideramos que hay sesión si el userDataDir existe Y contiene
 * el archivo de IndexedDB de WhatsApp. No es 100% fiable (el perfil podría
 * estar corrupto), pero sirve como pre-check antes de lanzar el navegador.
 */
export function sessionExists(): boolean {
  if (!existsSync(config.userDataDir)) return false;
  // Chromium crea IndexedDB en Default/IndexedDB/... — basta con que exista el dir Default
  return existsSync(`${config.userDataDir}/Default`);
}

/**
 * Borra completamente el perfil (reset total — obliga a volver a escanear QR).
 * Útil para tests o si la sesión se corrompe.
 */
export function wipeSession(): void {
  if (existsSync(config.userDataDir)) {
    rmSync(config.userDataDir, { recursive: true, force: true });
    logger.info({ userDataDir: config.userDataDir }, 'session wiped');
  }
}
```

**Nota importante sobre `fingerprint.ts`**: `getBrowserContextOptions()` probablemente devuelve también cosas como `permissions` que no aplican a `launchPersistentContext`. Revisa qué devuelve y pasa solo las opciones compatibles (viewport, locale, timezoneId, userAgent). Otras opciones de contexto (como `permissions`) se pasarían con `context.grantPermissions()` después.

### Actualizar callers

Los 4 archivos que llamaban `launchBrowser()` + `openContext()` ahora llaman una sola función. El patrón cambia de:

```typescript
const browser = await launchBrowser();
try {
  const context = await openContext(browser);
  const page = await context.newPage();
  // ...
} finally {
  await browser.close();
}
```

a:

```typescript
const context = await launchPersistentContextForTenant();
try {
  const page = context.pages()[0] ?? await context.newPage();
  // ...
} finally {
  await context.close();
}
```

**Importante**: `launchPersistentContext` ya abre una página por defecto. Usa `context.pages()[0]` si quieres la existente, o `newPage()` si prefieres una limpia. Y `context.close()` cierra TODO (no necesitas cerrar browser aparte).

#### Archivos a actualizar:

- `src/publisher/login.ts`: sustituir `launchBrowser` + `openContext` + `saveSession` por `launchPersistentContextForTenant`. Quitar `saveSession` (ya no existe — el contexto persiste automáticamente al cerrarse).
- `src/publisher/publish-text.ts`: mismo patrón. Quitar `await saveSession(context)` al final.
- `src/publisher/publish-media.ts`: idéntico.
- `src/cli/inspect.ts`: idéntico.

### Migración de datos

Si ya tenías `sessions/default.json` con una sesión antigua, **no es transferible** — el formato es distinto. Primera run tras el parche: vas a escanear QR una última vez. A partir de ahí, persiste.

Puedes borrar `sessions/default.json` cuando hayas migrado.

### Verificación

```bash
npm run build
rm -rf sessions/
npm run login          # escaneas QR una vez
ls sessions/default-profile/Default/  # debería tener IndexedDB/, Local Storage/, etc.
npm run publish        # debería abrir WA Web YA logueado, sin QR
```

---

<a id="parche-2"></a>
## Parche 2 — Selectores reales del DOM actual de WA Web

### Problema

`src/browser/selectors.ts` tiene varios selectores obsoletos que no matchean el DOM real. Los `data-testid` antiguos ya no existen.

### Solución

Reemplaza el contenido de `SELECTORS` por los selectores extraídos del dump real. Sube `SELECTORS_VERSION` a `0.3.0`.

```typescript
// src/browser/selectors.ts

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
```

### Verificación

```bash
npm run build  # TypeScript debe compilar limpio
npm run inspect -- --dump 'header'  # debería listar 1-2 headers
npm run inspect -- --dump 'span[aria-label$="seguidores"]'  # debería mostrar el contador
```

---

<a id="parche-3"></a>
## Parche 3 — `confirmChannelOpen` tolerante (composer como anchor)

### Problema

`confirmChannelOpen` en `src/publisher/publish-text.ts` línea 242 llama a `waitForAny(page, SELECTORS.openChannelHeader, { timeout: 15_000 })` y luego trata de leer `span[title]` dentro del header. Con los selectores antiguos nunca encuentra nada y tira timeout, aunque el canal ESTÉ abierto (confirmado en el screenshot).

### Causa raíz

Dos problemas apilados:

1. Los `data-testid` de los selectores antiguos no existen en el DOM real.
2. Incluso con el `<header>` genérico, extraer el nombre del canal vía `span[title]` es frágil — el título puede estar en varios spans con `title` distinto (emoji picker, etc.).

### Solución

Cambiar la filosofía: en lugar de "buscar header + validar título", usar **"esperar que el composer específico del canal aparezca"**. El composer tiene aria-label dinámico `"Escribir un mensaje para <nombre>"`, que es garantía de que:

- El canal está abierto (hay composer)
- Es el canal correcto (nombre coincide)

Y como fallback/logging, leer el contador de seguidores (info útil aunque no lo usemos para decisiones).

### Código nuevo

Sustituye la función `confirmChannelOpen` en `src/publisher/publish-text.ts` (líneas ~242-254):

```typescript
async function confirmChannelOpen(page: Page, expectedName: string): Promise<void> {
  // Estrategia primaria: esperar el composer específico de este canal.
  // aria-label dinámico = "Escribir un mensaje para <nombre>" ⇒ prueba de que
  // (a) el canal está abierto y (b) es el correcto, en un solo selector.
  const specificComposerSelectors = SELECTORS.messageComposerForChannel(expectedName);

  try {
    await waitForAnyDynamic(page, specificComposerSelectors, { timeout: 15_000 });
    logger.info({ channel: expectedName }, 'channel open — specific composer matched');
  } catch {
    // Fallback: composer genérico (cualquier canal).
    // Esto pasa si el idioma de la UI es otro o WA cambió el aria-label.
    logger.warn(
      { channel: expectedName },
      'specific composer not found, falling back to generic composer',
    );
    await waitForAny(page, SELECTORS.messageComposer, { timeout: 10_000 });
    logger.info('generic composer found — assuming channel is open');
  }

  // Bonus (no bloqueante): leer contador de seguidores para telemetría.
  try {
    const counter = await waitForAny(page, SELECTORS.openChannelSubscriberCount, {
      timeout: 2_000,
    });
    const text = await counter.getAttribute('aria-label');
    logger.info({ subscribers: text }, 'channel subscriber count read');
  } catch {
    // No pasa nada si no lo encuentra — es diagnóstico, no decisión.
  }
}
```

### Verificación

Después de aplicar este + el parche 2:

```bash
npm run publish -- --channel "Pruebas n8n" --text "test $(date +%s)"
```

Debería llegar al menos hasta el `typeAndSend` sin timeout en `confirmChannelOpen`.

---

<a id="parche-4"></a>
## Parche 4 — Orden correcto en `typeAndSend` (tipear → buscar send)

### Problema

`typeAndSend` usa `humanType(page, body)` (que tipea con `page.keyboard.type`, asume foco global). Después busca el send button. Dos problemas:

1. `page.keyboard.type` depende de que el foco esté en el composer, pero no hay garantía — `humanPause` antes podría haber cambiado el foco.
2. El send button **no existe cuando el composer está vacío**. Si `humanType` falla silenciosamente y no tipea nada, `waitForAny(sendButton)` nunca matchea (porque sigue habiendo `mic-outlined` en lugar de `send`), y falla por timeout.

### Solución

Tres mejoras combinadas:

1. **Usar `composer.pressSequentially()`** — el locator del composer lleva el foco implícito y Playwright tiene API nativa para tipear con delay por carácter.
2. **Verificar que el texto está en el composer** antes de intentar enviar. Leer `textContent` y comparar.
3. **Esperar explícitamente a que el `mic-outlined` desaparezca y aparezca el `send`** — evidencia de que WA detectó el texto.
4. **Fallback a `Enter`** como último recurso (en canales WA, Enter envía).

### Código nuevo

Sustituye la función `typeAndSend` en `src/publisher/publish-text.ts` (líneas ~260-282):

```typescript
async function typeAndSend(page: Page, body: string): Promise<void> {
  const composer = await waitForAny(page, SELECTORS.messageComposer, {
    timeout: 10_000,
  });

  // 1. Focus explícito en el composer
  await composer.click();
  await humanPause(page, [200, 500]);

  // 2. Tipear con pressSequentially (API de Playwright sobre el locator,
  // garantiza foco y maneja eventos de input correctamente para Lexical)
  await composer.pressSequentially(body, { delay: 50 });

  // 3. Verificar que el texto llegó al composer
  const typed = (await composer.textContent()) ?? '';
  if (typed.trim() !== body.trim()) {
    throw new Error(
      `composer text mismatch after typing: expected="${body}" got="${typed}"`,
    );
  }
  logger.debug({ typed }, 'composer text verified');

  // 4. Esperar a que el send button aparezca (desaparece el mic-outlined)
  //    Esto es la confirmación de que WA reconoció el texto.
  await humanPause(page, [600, 1400]);

  try {
    const sendBtn = await waitForAny(page, SELECTORS.sendButton, { timeout: 5_000 });
    await sendBtn.click();
    logger.debug('sent via send button');
    return;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'send button not found — falling back to Enter',
    );
  }

  // 5. Fallback: Enter (en canales WA Web, Enter envía sin Shift)
  await composer.focus();
  await page.keyboard.press('Enter');
  logger.debug('sent via Enter key fallback');
}
```

### Notas

- `pressSequentially` es la sustitución moderna de `type` sobre locators. Documentación: https://playwright.dev/docs/api/class-locator#locator-press-sequentially
- `delay: 50` es un delay fijo (no jitter aleatorio). Si quieres conservar el comportamiento de `humanType` con jitter, puedes mantenerlo pero sustituyéndolo por `composer.type(body, { delay: ... })` en lugar de `page.keyboard.type` — el delay sigue siendo fijo, pero la ventaja es que el locator asegura foco. Para jitter real, itera carácter a carácter con `composer.press(char)`.

### Verificación

Después de los parches 1–3 + este:

```bash
npm run publish -- --channel "Pruebas n8n" --text "ping $(date +%s)"
```

Deberías ver en el log:
- `composer text verified`
- `sent via send button` (o `sent via Enter key fallback`)
- `post-send verification OK`

Y el mensaje aparece en el canal.

---

<a id="parche-5"></a>
## Parche 5 — Cerrar overlay de onboarding antes de tipear

### Problema

En canales nuevos o con pocos seguidores, WA muestra un panel flotante ("Aumenta seguidores de X", con botón "Comparte enlace"). Ese panel puede:

- Tapar parcialmente el composer
- Interceptar clicks destinados al composer
- Confundir a los selectores (span adicional con "Pruebas n8n" en su contenido)

En el screenshot de la run 22:29 se ve claramente.

### Solución

Antes de `typeAndSend`, intenta cerrar cualquier overlay de onboarding si existe. Si no existe, no pasa nada (best-effort).

### Código nuevo

Añadir esta función en `src/publisher/publish-text.ts` y llamarla desde `navigateToChannel` justo después de `confirmChannelOpen`:

```typescript
/**
 * WA muestra paneles de onboarding en canales nuevos ("Aumenta seguidores",
 * "Comparte enlace"). Si existe, pueden tapar el composer. Best-effort close.
 */
async function dismissOnboardingOverlays(page: Page): Promise<void> {
  // Buscamos botones "Cerrar" que estén cerca de textos de onboarding típicos.
  // Damos margen corto — si no hay overlay, no queremos bloquear el flujo.
  try {
    const closeButton = await waitForAny(page, SELECTORS.onboardingCloseButton, {
      timeout: 1_500,
    });
    // Solo cerrar si es visible (evitar cerrar botones de otros diálogos por error)
    const isVisible = await closeButton.isVisible();
    if (isVisible) {
      await closeButton.click();
      logger.info('onboarding overlay dismissed');
      await page.waitForTimeout(400);
    }
  } catch {
    // No hay overlay — seguimos. Esto es el camino normal.
  }
}
```

Y en `navigateToChannel`:

```diff
 async function navigateToChannel(
   page: Page,
   ch: PublishTextInput['channelIdentifier'],
 ): Promise<void> {
   // Estrategia A: invite link directo (si lo tenemos)
   if (ch.inviteLink) {
     // ...
   }

   // Estrategia B: pestaña Canales + buscar por nombre
   logger.info({ name: ch.name }, 'navigating via Channels tab + name');
   await openChannelsTab(page);
   await selectChannelByName(page, ch.name);
   await confirmChannelOpen(page, ch.name);
+  await dismissOnboardingOverlays(page);
 }
```

### Verificación

En un canal con pocos seguidores (como "Pruebas n8n" con 9), la primera vez que lo abres deberías ver en logs `onboarding overlay dismissed`. En canales grandes o después de la primera vez que lo cierras, el overlay ya no aparece y el log simplemente no lo menciona.

---

<a id="extras"></a>
## Extras opcionales

### E1. Desactivar/marcar como experimental la rama de invite link

El dump de la run 1 confirma que navegar por invite link (`https://whatsapp.com/channel/<id>`) no abre el canal fiablemente. WA redirige a una página landing que pide seguir el canal.

Propuesta: desactivar la rama por defecto y exponerla como flag opcional.

```diff
 async function navigateToChannel(
   page: Page,
   ch: PublishTextInput['channelIdentifier'],
 ): Promise<void> {
-  // Estrategia A: invite link directo (si lo tenemos)
-  if (ch.inviteLink) {
+  // Invite link: sabido frágil — WA redirige a landing de "Seguir canal"
+  // cuando ya te has unido. Desactivado por defecto. Habilitar con
+  // TAMAYA_USE_INVITE_LINK=1 si quieres probar.
+  if (ch.inviteLink && process.env.TAMAYA_USE_INVITE_LINK === '1') {
     logger.info({ link: ch.inviteLink }, 'navigating via invite link (experimental)');
     // ...
   }
```

### E2. Detector de "sesión expirada" 

Si al abrir WA Web aparece el QR a pesar de tener `userDataDir` poblado, es que la sesión caducó (puede pasar si no abres el móvil en 14 días). Detéctalo:

```typescript
// En publish-text.ts, después de page.goto:
const qrVisible = await page.locator('canvas[aria-label*="Escanea" i]').isVisible().catch(() => false);
if (qrVisible) {
  throw new Error(
    'session expired — QR visible. Run `npm run login` to re-authenticate.',
  );
}
```

### E3. Simplificar fingerprint para uso personal

Dado que es uso personal con una sola cuenta, la variación de fingerprint entre tenants no aplica (solo hay uno — tú). Puedes:

- Dejar el UA, viewport, timezone, locale como defaults de Playwright (quitar overrides en `fingerprint.ts`)
- Mantener solo el UA si quieres controlar la versión de Chrome que reporta

Esto simplifica el código y reduce riesgo de inconsistencias (p.ej. UA dice Chrome 127 pero Playwright corre Chromium 131).

### E4. Limpieza post-PoC

Cuando funcione end-to-end, buen momento para:

- Borrar `fingerprint.ts` si decidiste simplificar (E3)
- Borrar `sessions/*.json` antiguos (del enfoque storageState)
- Actualizar README con el nuevo `TAMAYA_USER_DATA_DIR`
- Actualizar `POC-BACKLOG` — Phase 2 desbloqueada

---

## Checklist de aplicación

Orden sugerido (permite probar tras cada paso):

- [ ] **P1** Renombrar `sessionPath` → `userDataDir` en `config.ts` y `.env.example`
- [ ] **P1** Reescribir `src/browser/session.ts` con `launchPersistentContext`
- [ ] **P1** Actualizar `login.ts` (quitar `saveSession`, usar nueva API)
- [ ] **P1** Actualizar `publish-text.ts` (nueva API, quitar `saveSession`)
- [ ] **P1** Actualizar `publish-media.ts` (nueva API)
- [ ] **P1** Actualizar `inspect.ts` (nueva API)
- [ ] `npm run build` — verificar compilación limpia
- [ ] `rm -rf sessions/ && npm run login` — escanear QR UNA ÚLTIMA VEZ
- [ ] `npm run publish` — debería arrancar WA Web YA logueado
- [ ] **P2** Sustituir `SELECTORS` en `selectors.ts` por los nuevos
- [ ] **P3** Sustituir `confirmChannelOpen` en `publish-text.ts`
- [ ] **P4** Sustituir `typeAndSend` en `publish-text.ts`
- [ ] **P5** Añadir `dismissOnboardingOverlays` + llamada en `navigateToChannel`
- [ ] `npm run build`
- [ ] Test end-to-end: `npm run publish -- --channel "Pruebas n8n" --text "hello"`
- [ ] Verificar mensaje aparece en el canal desde el móvil

## Rollback

Tienes git. Si algo rompe:

```bash
git diff
git checkout -- src/
```

Y vuelve a aplicar parche a parche de nuevo.

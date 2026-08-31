/**
 * Captura de las Estadísticas de un canal (Alcance / Crecimiento / Seguidores).
 *
 * Flujo:
 *  1. Cargar sesión + abrir WA Web
 *  2. Navegar al canal (reutiliza navigateToChannel de publish-text)
 *  3. Menú (3 puntos) → "Info. del canal" → "Ver todo" → drawer de Estadísticas
 *  4. Leer las 3 pestañas (readChannelInsights)
 *
 * A diferencia de publishText/publishMedia esto es de solo lectura: no hay
 * "punto de no retorno" ni verificación post-envío, así que cualquier fallo es
 * simplemente reintentable por quien llame.
 *
 * `captureInsightsOnPage` se expone aparte de `captureChannelInsights` para que
 * quien capture VARIOS canales (control-server, ver `/insights/capture` sin
 * `channelId`) pueda abrir un único contexto/página de Chromium y navegar
 * canal a canal dentro de la misma sesión — igual que lo haría un humano —
 * en vez de abrir y cerrar el navegador una vez por canal.
 */
import type { Page } from 'playwright';
import {
  launchPersistentContextForTenant,
  sessionExists,
} from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import { waitForAppReady } from '../browser/app-state.js';
import { dismissBlockingDialogs, clickWithDialogGuard } from '../browser/dialogs.js';
import { dumpDebugInfo, humanPause, waitForAny } from '../browser/dom-helpers.js';
import { logger } from '../logger.js';
import { navigateToChannel } from './publish-text.js';
import { readChannelInsights } from '../metrics/channel-insights.js';
import type { ChannelInsights } from '@tamaya/shared-types';

export interface ChannelIdentifier {
  inviteLink?: string;
  whatsappId?: string;
  name: string;
}

export interface CaptureInsightsInput {
  channelIdentifier: ChannelIdentifier;
}

export interface CaptureInsightsResult {
  success: boolean;
  insights?: ChannelInsights;
  error?: string;
  debugDump?: string;
}

/**
 * Abre el drawer de Estadísticas del canal (menú → Info del canal → Ver todo)
 * y lo deja listo para leer. Asume que ya se navegó al canal correcto.
 */
async function openChannelInsightsDrawer(page: Page): Promise<void> {
  const menuBtn = await waitForAny(page, SELECTORS.channelMenuButton, { timeout: 10_000 });
  await humanPause(page, [300, 600]);
  await clickWithDialogGuard(page, menuBtn, 'channel menu (3 puntos)');

  const infoBtn = await waitForAny(page, SELECTORS.channelMenuInfoButton, { timeout: 8_000 });
  await humanPause(page, [200, 400]);
  await clickWithDialogGuard(page, infoBtn, 'Info. del canal');

  let seeAllBtn;
  try {
    seeAllBtn = await waitForAny(page, SELECTORS.channelInfoInsightsSeeAllButton, { timeout: 10_000 });
  } catch (err) {
    // WA oculta "Ver todo"/"See all" y muestra este aviso cuando el canal aún
    // no llega al mínimo de seguidores exigido para el panel completo.
    // Verificado contra dump real (2026-08-31), ambos idiomas:
    //   en: "Insights are available after reaching 100 followers."
    //   es: "Las estadísticas están disponibles luego de llegar a 100 seguidores."
    // No es un selector roto — es un estado legítimo del canal.
    const notice = await page
      .locator('[data-testid="channel-admin-insights-insights-section"]')
      .innerText({ timeout: 1_000 })
      .catch(() => '');
    if (/reaching \d+ followers|llegar a \d+ seguidores/i.test(notice)) {
      throw new Error(
        `INSIGHTS_NOT_AVAILABLE_YET: el canal aún no tiene suficientes seguidores para el panel ` +
          `completo de Estadísticas (WA: "${notice.trim()}")`,
      );
    }
    throw err;
  }
  await humanPause(page, [200, 400]);
  await clickWithDialogGuard(page, seeAllBtn, 'Ver todo (estadísticas)');

  await waitForAny(page, SELECTORS.insightsDrawer, { timeout: 15_000 });
}

/**
 * Navega a un canal, abre su drawer de Estadísticas y lo lee. Asume que
 * `page` ya está en WA Web con la app lista (WA Web cargado, no hace goto).
 *
 * Al terminar cierra el drawer/panel con Escape (best-effort) para dejar la
 * página lista para navegar al siguiente canal en un bucle multi-canal.
 */
export async function captureInsightsOnPage(
  page: Page,
  channelIdentifier: ChannelIdentifier,
): Promise<ChannelInsights> {
  await navigateToChannel(page, channelIdentifier);
  // Abrir el canal puede disparar su propio onboarding, que taparía el menú.
  await dismissBlockingDialogs(page);

  await openChannelInsightsDrawer(page);
  const insights = await readChannelInsights(page);

  // Best-effort: cerrar el panel de info/estadísticas antes del siguiente
  // canal. No es crítico si falla — navigateToChannel del siguiente canal
  // reabre el canal correcto de todos modos.
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape').catch(() => undefined);

  return insights;
}

/** Captura las estadísticas de UN canal: abre y cierra su propio contexto de Chromium. */
export async function captureChannelInsights(
  input: CaptureInsightsInput,
): Promise<CaptureInsightsResult> {
  if (!sessionExists()) {
    return { success: false, error: 'No session found — run `npm run login` first' };
  }

  const context = await launchPersistentContextForTenant('control-server');
  let debugDump: string | undefined;

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    logger.info({ channel: input.channelIdentifier.name }, 'capturing channel insights');
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60_000 });
    await dismissBlockingDialogs(page);

    const insights = await captureInsightsOnPage(page, input.channelIdentifier);

    logger.info(
      { channel: input.channelIdentifier.name, tabsAvailable: insights.tabsAvailable },
      'channel insights captured',
    );
    return { success: true, insights };
  } catch (err) {
    const page = context.pages()[0];
    if (page) {
      try {
        debugDump = await dumpDebugInfo(page, 'capture-insights-fail');
      } catch {
        /* ya logueado */
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, channel: input.channelIdentifier.name }, 'captureChannelInsights failed');
    return { success: false, error: errMsg, debugDump };
  } finally {
    await context.close();
  }
}

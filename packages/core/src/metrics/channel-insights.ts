/**
 * Lectura del panel "Estadísticas" de un canal de WhatsApp (solo admin).
 *
 * El panel tiene tres pestañas: Alcance, Crecimiento y Seguidores. Este módulo
 * las lee del DOM y devuelve JSON, sin tocar nada salvo clicar las propias
 * pestañas para pasar de una a otra.
 *
 * Dos cosas que condicionan el diseño:
 *
 *  1. WA abrevia los números grandes ("2,7 mil") ⇒ el desglose es aproximado.
 *     Por eso cada métrica lleva `exact` y el texto original (ver parse-number).
 *  2. Los gráficos (donut de Alcance, línea temporal de Crecimiento) son
 *     `<canvas>` (Konva): de ahí no se puede leer nada. Todos los datos que
 *     exponemos salen del texto de las leyendas, no de los gráficos.
 *
 * Los tipos (`ChannelInsights`, `ChannelReach`, `ChannelGrowth`,
 * `ChannelFollowers`, `Metric`, ...) viven en `@tamaya/shared-types`: los
 * necesita también `packages/db` (columna JSON del snapshot) sin arrastrar la
 * dependencia de Playwright que tiene este paquete.
 */
import type { Locator, Page } from 'playwright';

import { logger } from '../logger.js';
import { SELECTORS } from '../browser/selectors.js';
import { waitForAny } from '../browser/dom-helpers.js';
import { parseWaNumber } from './parse-number.js';
import type {
  BarChartRow,
  ChannelFollowers,
  ChannelGrowth,
  ChannelGrowthItem,
  ChannelInsights,
  ChannelReach,
  InsightsDateRange,
  Metric,
  ReachSegment,
} from '@tamaya/shared-types';

/** innerText del primer nodo que matchee, o null. Nunca lanza. */
async function textOf(scope: Locator | Page, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const el = scope.locator(selector).first();
    if ((await el.count().catch(() => 0)) === 0) continue;
    const text = await el.innerText().catch(() => null);
    if (text !== null && text.trim() !== '') return text.trim();
  }
  return null;
}

/** Métrica a partir del primer nodo que matchee. */
async function metricOf(scope: Locator, selectors: readonly string[]): Promise<Metric> {
  const raw = await textOf(scope, selectors);
  return raw === null ? { value: null, exact: false, raw: '' } : parseWaNumber(raw);
}

/** Primer locator existente entre varios candidatos, o null. */
async function firstPresent(scope: Locator | Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const el = scope.locator(selector).first();
    if ((await el.count().catch(() => 0)) > 0) return el;
  }
  return null;
}

/** Todos los nodos que matcheen el primer selector con resultados. */
async function allOf(scope: Locator, selectors: readonly string[]): Promise<Locator[]> {
  for (const selector of selectors) {
    const loc = scope.locator(selector);
    const n = await loc.count().catch(() => 0);
    if (n > 0) return Array.from({ length: n }, (_, i) => loc.nth(i));
  }
  return [];
}

/** "Últimos 30 días\n14 jul. - 12 ago." → { label, range } */
function splitDateRange(text: string | null): InsightsDateRange {
  if (text === null) return { label: null, range: null };
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return { label: lines[0] ?? null, range: lines[1] ?? null };
}

/**
 * Selecciona una pestaña del drawer (Alcance/Crecimiento/Seguidores) si no lo
 * está ya, y espera a que WA marque `aria-selected="true"` (re-renderiza el
 * contenido tras el click). No lanza si la pestaña no existe — el llamador ya
 * comprueba `tabsAvailable` antes de intentarlo.
 */
async function selectTab(drawer: Locator, tabSelectors: readonly string[]): Promise<void> {
  const tab = await firstPresent(drawer, tabSelectors);
  if (tab === null) return;
  const alreadySelected = (await tab.getAttribute('aria-selected').catch(() => null)) === 'true';
  if (alreadySelected) return;

  await tab.click();
  const page = tab.page();
  for (let i = 0; i < 15; i += 1) {
    if ((await tab.getAttribute('aria-selected').catch(() => null)) === 'true') return;
    await page.waitForTimeout(200);
  }
  logger.warn({ tabSelectors }, 'selectTab: aria-selected no confirmado tras el click — se continúa igual');
}

/** Lee la pestaña Alcance. Asume que ya está seleccionada. */
export async function readReachTab(drawer: Locator): Promise<ChannelReach> {
  const accountsReached = await metricOf(drawer, SELECTORS.insightsReachTotal);

  const segments: ReachSegment[] = [];
  for (const item of await allOf(drawer, SELECTORS.insightsReachLegendItem)) {
    const count = await metricOf(item, SELECTORS.insightsLegendCount);
    const deltaRaw = await textOf(item, SELECTORS.insightsLegendDelta);
    // La etiqueta es el texto de la fila menos el recuento y el porcentaje.
    const full = (await item.innerText().catch(() => '')) ?? '';
    const label = full
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && l !== count.raw && l !== deltaRaw)[0] ?? '';
    segments.push({
      label,
      count,
      percent: deltaRaw === null ? null : parseWaNumber(deltaRaw).value,
    });
  }

  const topRegions = await readBarChartRows(drawer);
  return { accountsReached, segments, topRegions };
}

/** Filas de "Principales regiones" (u otro bar-chart). Compartido entre pestañas. */
async function readBarChartRows(drawer: Locator): Promise<BarChartRow[]> {
  const topRegions: BarChartRow[] = [];
  for (const row of await allOf(drawer, SELECTORS.insightsBarChartRow)) {
    const label = await textOf(row, SELECTORS.insightsBarLabel);
    const value = await metricOf(row, SELECTORS.insightsBarValue);
    const percentRaw = await textOf(row, SELECTORS.insightsBarPercent);
    topRegions.push({
      label: label ?? '',
      value,
      percent: percentRaw === null ? null : parseWaNumber(percentRaw).value,
    });
  }
  return topRegions;
}

/**
 * Lee la pestaña Crecimiento: 3 filas (netos nuevos / nuevos / bajas). Cada
 * fila tiene dos `div` hijos directos: el primero con icono+etiqueta, el
 * segundo con el valor — sin testid propio para el valor, así que se lee por
 * posición (el icono es aria-hidden y no aporta texto al innerText).
 */
export async function readGrowthTab(drawer: Locator): Promise<ChannelGrowth> {
  const items: ChannelGrowthItem[] = [];
  for (const item of await allOf(drawer, SELECTORS.insightsGrowthLegendItem)) {
    const children = item.locator('> div');
    const count = await children.count().catch(() => 0);
    if (count < 2) continue;
    const label = ((await children.nth(0).innerText().catch(() => '')) ?? '').trim();
    const valueRaw = ((await children.nth(1).innerText().catch(() => '')) ?? '').trim();
    items.push({ label, value: parseWaNumber(valueRaw) });
  }
  return { items };
}

/**
 * Lee la pestaña Seguidores: total + variación porcentual + etiqueta del
 * periodo ("en los últimos 30 días"), más "Principales regiones" (mismo
 * widget que en Alcance, con valores propios de esta pestaña).
 */
export async function readFollowersTab(drawer: Locator): Promise<ChannelFollowers> {
  const container = await firstPresent(drawer, SELECTORS.insightsValueWithDelta);

  let total: Metric = { value: null, exact: false, raw: '' };
  let deltaPercent: number | null = null;
  let periodLabel: string | null = null;

  if (container !== null) {
    total = await metricOf(container, SELECTORS.insightsBarValue);
    const deltaRaw = await textOf(container, SELECTORS.insightsDeltaCell);
    deltaPercent = deltaRaw === null ? null : parseWaNumber(deltaRaw).value;

    // La etiqueta del periodo es un div hermano de "delta", sin testid propio:
    // se obtiene por descarte del texto completo del contenedor.
    const full = (await container.innerText().catch(() => '')) ?? '';
    periodLabel = full
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && l !== total.raw && l !== deltaRaw)[0] ?? null;
  }

  const topRegions = await readBarChartRows(drawer);
  return { total, deltaPercent, periodLabel, topRegions };
}

/**
 * Lee el panel de Estadísticas que ya esté abierto en pantalla, recorriendo
 * sus 3 pestañas (Alcance, Crecimiento, Seguidores).
 *
 * @throws si el drawer no está abierto (con el diagnóstico de `waitForAny`).
 */
export async function readChannelInsights(page: Page): Promise<ChannelInsights> {
  await waitForAny(page, SELECTORS.insightsDrawer, { timeout: 15_000 });
  const drawer = await firstPresent(page, SELECTORS.insightsDrawer);
  if (drawer === null) throw new Error('insights drawer not found after waitForAny');

  const tabsAvailable: string[] = [];
  for (const [name, selectors] of [
    ['reach', SELECTORS.insightsTabReach],
    ['growth', SELECTORS.insightsTabGrowth],
    ['followers', SELECTORS.insightsTabFollowers],
  ] as const) {
    if ((await firstPresent(drawer, selectors)) !== null) tabsAvailable.push(name);
  }

  let reach: ChannelReach | null = null;
  let growth: ChannelGrowth | null = null;
  let followers: ChannelFollowers | null = null;
  let dateRange: InsightsDateRange = { label: null, range: null };

  if (tabsAvailable.includes('reach')) {
    await selectTab(drawer, SELECTORS.insightsTabReach);
    reach = await readReachTab(drawer);
    // La ventana de fechas se comparte entre Alcance y Crecimiento; Seguidores
    // no la muestra (el total es acumulado, no por periodo). Se lee aquí.
    dateRange = splitDateRange(await textOf(drawer, SELECTORS.insightsDateRangeRow));
  }
  if (tabsAvailable.includes('growth')) {
    await selectTab(drawer, SELECTORS.insightsTabGrowth);
    growth = await readGrowthTab(drawer);
  }
  if (tabsAvailable.includes('followers')) {
    await selectTab(drawer, SELECTORS.insightsTabFollowers);
    followers = await readFollowersTab(drawer);
  }

  logger.info(
    {
      tabsAvailable,
      accountsReached: reach?.accountsReached.value,
      growthItems: growth?.items.length,
      followersTotal: followers?.total.value,
    },
    'channel insights read',
  );

  return { dateRange, reach, growth, followers, tabsAvailable, readAt: new Date().toISOString() };
}

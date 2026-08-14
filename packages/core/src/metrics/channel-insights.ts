/**
 * Lectura del panel "Estadísticas" de un canal de WhatsApp (solo admin).
 *
 * El panel tiene tres pestañas: Alcance, Crecimiento y Seguidores. Este módulo
 * las lee del DOM y devuelve JSON, sin tocar nada: es de solo lectura.
 *
 * Dos cosas que condicionan el diseño:
 *
 *  1. WA abrevia los números grandes ("2,7 mil") ⇒ el desglose es aproximado.
 *     Por eso cada métrica lleva `exact` y el texto original (ver parse-number).
 *  2. El donut es un <canvas> (Konva): de ahí no se puede leer nada. Todos los
 *     datos que exponemos salen del texto de la leyenda, no del gráfico.
 */
import type { Locator, Page } from 'playwright';

import { logger } from '../logger.js';
import { SELECTORS } from '../browser/selectors.js';
import { waitForAny } from '../browser/dom-helpers.js';
import { parseWaNumber, type ParsedNumber } from './parse-number.js';

/** Métrica con valor, marca de exactitud y texto original. */
export type Metric = ParsedNumber;

export interface ReachSegment {
  /** Etiqueta tal y como la muestra WA ("Seguidores", "No seguidores"). */
  label: string;
  count: Metric;
  /** Porcentaje sobre el total alcanzado. */
  percent: number | null;
}

export interface BarChartRow {
  label: string;
  value: Metric;
  percent: number | null;
}

export interface ChannelReach {
  /** Total de cuentas alcanzadas. WA lo da sin abreviar. */
  accountsReached: Metric;
  /** Desglose seguidores / no seguidores. */
  segments: ReachSegment[];
  /** "Principales regiones". */
  topRegions: BarChartRow[];
}

export interface InsightsDateRange {
  /** Etiqueta del periodo ("Últimos 30 días"). */
  label: string | null;
  /** Rango literal ("14 jul. - 12 ago."). */
  range: string | null;
}

export interface ChannelInsights {
  dateRange: InsightsDateRange;
  reach: ChannelReach | null;
  /** Pestañas presentes en el panel, por si WA añade o quita alguna. */
  tabsAvailable: string[];
  readAt: string;
}

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

  return { accountsReached, segments, topRegions };
}

/**
 * Lee el panel de Estadísticas que ya esté abierto en pantalla.
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

  const dateRange = splitDateRange(await textOf(drawer, SELECTORS.insightsDateRangeRow));
  const reach = await readReachTab(drawer);

  logger.info(
    {
      accountsReached: reach.accountsReached.value,
      segments: reach.segments.length,
      regions: reach.topRegions.length,
      tabsAvailable,
    },
    'channel insights read',
  );

  return { dateRange, reach, tabsAvailable, readAt: new Date().toISOString() };
}

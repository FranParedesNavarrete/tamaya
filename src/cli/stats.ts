#!/usr/bin/env node
/**
 * CLI: `npm run stats`
 *
 * Muestra estadísticas básicas de envíos (tasa de éxito, tiempos p50/p95).
 */
import { db } from '../db/client.js';

interface Row {
  status: string;
  n: number;
  avg_ms: number | null;
}

const rows = db
  .prepare(
    `SELECT status, COUNT(*) AS n, AVG(duration_ms) AS avg_ms
     FROM messages
     GROUP BY status
     ORDER BY n DESC`,
  )
  .all() as Row[];

const total = rows.reduce((acc, r) => acc + r.n, 0);
if (total === 0) {
  console.log('No messages yet. Send some with `npm run publish`.');
  process.exit(0);
}

console.log(`\nTotal: ${total}\n`);
console.table(
  rows.map((r) => ({
    status: r.status,
    count: r.n,
    pct: `${((r.n / total) * 100).toFixed(1)}%`,
    avg_ms: r.avg_ms ? Math.round(r.avg_ms) : '-',
  })),
);

// Percentiles (rough) sobre todos los envíos con duración
const durations = (
  db.prepare('SELECT duration_ms FROM messages WHERE duration_ms IS NOT NULL ORDER BY duration_ms').all() as Array<{
    duration_ms: number;
  }>
).map((r) => r.duration_ms);

function pct(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
  return arr[idx];
}

const p50 = pct(durations, 50);
const p95 = pct(durations, 95);
console.log(`\nDuration  p50: ${p50 ?? '-'} ms   p95: ${p95 ?? '-'} ms\n`);

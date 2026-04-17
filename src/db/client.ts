/**
 * Cliente SQLite. Inicializa el schema en el primer arranque.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schemaPath = join(__dirname, 'schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');
db.exec(schema);

logger.debug({ dbPath: config.dbPath }, 'SQLite ready');

export function audit(
  actor: string,
  action: string,
  target?: string,
  metadata?: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO audit_log (tenant_id, actor, action, target, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    config.tenantId,
    actor,
    action,
    target ?? null,
    metadata ? JSON.stringify(metadata) : null,
  );
}

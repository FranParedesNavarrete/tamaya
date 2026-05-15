import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

let _pool: mysql.Pool | null = null;

/**
 * Configuración SSL para la conexión MySQL.
 *
 * AWS RDS exige TLS por defecto y firma con su propia CA. Casos:
 *
 *  - `DATABASE_SSL=disable` → sin TLS (solo MySQL local sin SSL).
 *  - `DATABASE_SSL=require` (default si la URL apunta a RDS) → TLS, pero NO
 *    verifica la CA. Suficientemente seguro para tráfico dentro de VPC o
 *    desde IPs autorizadas en el security group, y no requiere distribuir
 *    el bundle de certificados de Amazon a cada deploy.
 *  - `DATABASE_SSL=verify` → TLS verificando contra la CA del sistema.
 *    Requiere tener el bundle de RDS instalado (`global-bundle.pem`).
 */
function resolveSslOption(url: string): mysql.PoolOptions['ssl'] | undefined {
  const explicit = process.env.DATABASE_SSL?.toLowerCase();
  if (explicit === 'disable' || explicit === 'false' || explicit === 'off') {
    return undefined;
  }
  const isRds = /\.rds\.amazonaws\.com\b/i.test(url);
  if (explicit === 'verify') return { rejectUnauthorized: true };
  if (explicit === 'require' || isRds) return { rejectUnauthorized: false };
  return undefined;
}

export function getPool(): mysql.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    _pool = mysql.createPool({
      uri: url,
      connectionLimit: 10,
      enableKeepAlive: true,
      ssl: resolveSslOption(url),
    });
  }
  return _pool;
}

export function getDb() {
  return drizzle(getPool(), { schema, mode: 'default' });
}

export { schema };

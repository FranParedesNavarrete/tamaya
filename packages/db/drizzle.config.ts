import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { Config } from 'drizzle-kit';

// Carga el .env del repo raíz (packages/db/../../.env)
loadEnv({ path: resolve(__dirname, '../../.env') });

const dbUrl = process.env.DATABASE_URL ?? 'mysql://tamaya:tamaya@localhost:3306/tamaya';
const isRds = /\.rds\.amazonaws\.com\b/i.test(dbUrl);
const sslMode = process.env.DATABASE_SSL?.toLowerCase();
const useSsl = sslMode !== 'disable' && sslMode !== 'false' && sslMode !== 'off' && (sslMode === 'require' || sslMode === 'verify' || isRds);

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'mysql',
  dbCredentials: useSsl
    ? { url: dbUrl, ssl: { rejectUnauthorized: sslMode === 'verify' } }
    : { url: dbUrl },
} satisfies Config;

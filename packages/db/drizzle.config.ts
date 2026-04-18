import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { Config } from 'drizzle-kit';

// Carga el .env del repo raíz (packages/db/../../.env)
loadEnv({ path: resolve(__dirname, '../../.env') });

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://tamaya:tamaya@localhost:3306/tamaya',
  },
} satisfies Config;

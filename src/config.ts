import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optionalInt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? Number.parseInt(v, 10) : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_URL: z.string().default('http://localhost:3000'),

  JOBS_TOKEN: z.string().min(16, 'JOBS_TOKEN debe tener al menos 16 caracteres'),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN debe tener al menos 16 caracteres'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  RUN_MIGRATIONS_ON_START: bool,

  WOO_URL: z.url(),
  WOO_CONSUMER_KEY: z.string(),
  WOO_CONSUMER_SECRET: z.string(),
  WOO_WEBHOOK_SECRET: z.string().min(8),
  SYNC_ORDER_STATUSES: csv,
  WOO_VAT_META_KEYS: csv,

  TARGET: z.enum(['odoo']).default('odoo'),

  ODOO_URL: z.url(),
  ODOO_DB: z.string(),
  ODOO_LOGIN: z.string(),
  ODOO_API_KEY: z.string(),
  ODOO_API: z.enum(['json2', 'jsonrpc']).default('json2'),
  ODOO_CONFIRM_ORDERS: bool,
  ODOO_SHIPPING_PRODUCT_SKU: z.string().default('ENVIO'),
  ODOO_FEE_PRODUCT_SKU: z.string().default('CARGO'),
  ODOO_ORDER_REF_PREFIX: z.string().default('WEB-'),

  STOCK_SYNC_ENABLED: bool,
  ODOO_STOCK_LOCATION_ID: optionalInt,

  JOBS_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  JOBS_TIME_BUDGET_MS: z.coerce.number().int().positive().default(25_000),
  JOBS_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida. Revisa las variables de entorno:\n${issues}`);
  }
  return parsed.data;
}

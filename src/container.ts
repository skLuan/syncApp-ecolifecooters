import { createRequire } from 'node:module';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { LogNotifier } from './core/notifier.js';
import { JobProcessor } from './core/processor.js';
import { MysqlJobQueue } from './core/queue.js';
import { MysqlIdMap, MysqlStateStore, MysqlSyncLog } from './core/store.js';
import { createPool, pingDb } from './db/pool.js';
import type { AppServices } from './http/services.js';
import { runStockSyncSafe } from './jobs/stock-sync.js';
import { WooClient } from './sources/woo/client.js';
import { wooOrderToOrder } from './sources/woo/mapper.js';
import { createTarget } from './targets/index.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

/** Arma todas las piezas reales a partir de la configuración. */
export function createServices(config: Config, log: FastifyBaseLogger) {
  const db = createPool(config);
  const queue = new MysqlJobQueue(db);
  const idMap = new MysqlIdMap(db);
  const syncLog = new MysqlSyncLog(db);
  const state = new MysqlStateStore(db);
  const target = createTarget(config, idMap);
  const woo = new WooClient({
    baseUrl: config.WOO_URL,
    consumerKey: config.WOO_CONSUMER_KEY,
    consumerSecret: config.WOO_CONSUMER_SECRET,
  });

  const processor = new JobProcessor({
    queue,
    target,
    syncLog,
    woo,
    notifier: new LogNotifier(log),
    log,
    parseOrder: (payload) => wooOrderToOrder(payload, { vatMetaKeys: config.WOO_VAT_META_KEYS }),
    options: {
      syncStatuses: config.SYNC_ORDER_STATUSES,
      maxAttempts: config.JOBS_MAX_ATTEMPTS,
      batchSize: config.JOBS_BATCH_SIZE,
      timeBudgetMs: config.JOBS_TIME_BUDGET_MS,
    },
  });

  const services: AppServices = {
    settings: {
      jobsToken: config.JOBS_TOKEN,
      adminToken: config.ADMIN_TOKEN,
      wooWebhookSecret: config.WOO_WEBHOOK_SECRET,
      syncStatuses: config.SYNC_ORDER_STATUSES,
      version: pkg.version,
      targetName: target.name,
    },
    queue,
    processor,
    stockSync: config.STOCK_SYNC_ENABLED
      ? () => runStockSyncSafe({ target, woo, idMap, state, syncLog })
      : null,
    pingDb: () => pingDb(db),
  };

  return { services, db, target };
}

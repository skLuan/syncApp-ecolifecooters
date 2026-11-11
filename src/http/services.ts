import type { RunSummary } from '../core/processor.js';
import type { JobQueue } from '../core/queue.js';

/**
 * Lo que las rutas HTTP necesitan. Se arma en container.ts (producción)
 * o con dobles en los tests.
 */
export interface AppServices {
  settings: {
    jobsToken: string;
    adminToken: string;
    wooWebhookSecret: string;
    syncStatuses: string[];
    version: string;
    targetName: string;
  };
  queue: JobQueue;
  processor: { run(limit?: number): Promise<RunSummary> };
  /** null si la sincronización de stock está desactivada */
  stockSync: (() => Promise<unknown>) | null;
  pingDb: () => Promise<boolean>;
}

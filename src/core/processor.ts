import { errorMessage, PermanentError } from './errors.js';
import type { Order } from './model.js';
import type { Notifier } from './notifier.js';
import { backoffSeconds, type Job, type JobQueue } from './queue.js';
import type { SyncLog } from './store.js';
import type { TargetAdapter } from './target.js';
import { assertOrderSyncable } from './validate.js';

export const JOB_WOO_ORDER = 'woo.order';

type Logger = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

/** Lo mínimo que el procesador necesita de WooCommerce (facilita los tests). */
export interface WooOrderWriter {
  setOrderMeta(orderId: string, key: string, value: string): Promise<void>;
}

export interface ProcessorDeps {
  queue: JobQueue;
  target: TargetAdapter;
  syncLog: SyncLog;
  woo: WooOrderWriter;
  notifier: Notifier;
  log: Logger;
  /** Traduce el payload de la fuente al modelo común (inyectado: el núcleo no conoce WooCommerce). */
  parseOrder: (payload: unknown) => Order;
  options: {
    syncStatuses: string[];
    maxAttempts: number;
    batchSize: number;
    timeBudgetMs: number;
  };
}

export interface RunSummary {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
  skippedBusy?: boolean;
}

export class JobProcessor {
  private running = false;

  constructor(private readonly d: ProcessorDeps) {}

  /**
   * Procesa jobs hasta agotar el lote o el tiempo. Si ya hay una ejecución en curso
   * en este proceso, no hace nada (la cola en MySQL protege también entre procesos).
   */
  async run(limit = this.d.options.batchSize): Promise<RunSummary> {
    if (this.running) return { claimed: 0, done: 0, retried: 0, dead: 0, skippedBusy: true };
    this.running = true;
    const summary: RunSummary = { claimed: 0, done: 0, retried: 0, dead: 0 };
    const deadline = Date.now() + this.d.options.timeBudgetMs;

    try {
      while (Date.now() < deadline && summary.claimed < limit) {
        const jobs = await this.d.queue.claim(Math.min(5, limit - summary.claimed));
        if (jobs.length === 0) break;
        summary.claimed += jobs.length;
        for (const job of jobs) {
          const outcome = await this.handle(job);
          summary[outcome] += 1;
        }
      }
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async handle(job: Job): Promise<'done' | 'retried' | 'dead'> {
    try {
      await this.execute(job);
      await this.d.queue.complete(job.id);
      return 'done';
    } catch (err) {
      const message = errorMessage(err);
      const permanent = err instanceof PermanentError;
      const exhausted = job.attempts >= this.d.options.maxAttempts;

      if (permanent || exhausted) {
        await this.d.queue.fail(job.id, message, { dead: true });
        await this.d.syncLog.write({
          jobId: job.id,
          entityKey: job.entityKey,
          level: 'error',
          message,
        });
        await this.d.notifier.alert(
          `Sincronización fallida (${job.entityKey})`,
          `Job ${job.id} tras ${job.attempts} intento(s): ${message}`,
        );
        this.d.log.error({ jobId: job.id, entity: job.entityKey, err: message }, 'job dead');
        return 'dead';
      }

      const delay = backoffSeconds(job.attempts);
      await this.d.queue.fail(job.id, message, { retryInSeconds: delay });
      await this.d.syncLog.write({
        jobId: job.id,
        entityKey: job.entityKey,
        level: 'warn',
        message: `Reintento en ${Math.round(delay / 60)} min: ${message}`,
      });
      this.d.log.warn({ jobId: job.id, entity: job.entityKey, err: message, delay }, 'job retry');
      return 'retried';
    }
  }

  private async execute(job: Job): Promise<void> {
    switch (job.type) {
      case JOB_WOO_ORDER:
        return this.syncWooOrder(job);
      default:
        throw new PermanentError(`Tipo de job desconocido: ${job.type}`);
    }
  }

  private async syncWooOrder(job: Job): Promise<void> {
    const order = this.d.parseOrder(job.payload);

    if (!this.d.options.syncStatuses.includes(order.status)) {
      await this.d.syncLog.write({
        jobId: job.id,
        entityKey: job.entityKey,
        level: 'info',
        message: `Ignorado: estado "${order.status}" no está en SYNC_ORDER_STATUSES`,
      });
      return;
    }

    assertOrderSyncable(order);
    const result = await this.d.target.upsertOrder(order);

    for (const w of result.warnings) {
      await this.d.syncLog.write({
        jobId: job.id,
        entityKey: job.entityKey,
        level: 'warn',
        message: w,
      });
      this.d.log.warn({ jobId: job.id, entity: job.entityKey }, w);
    }

    if (!result.alreadyExisted) {
      // Best effort: si falla, el pedido YA está en el destino; solo se registra.
      try {
        await this.d.woo.setOrderMeta(
          order.externalId,
          `_${this.d.target.name}_id`,
          result.targetId,
        );
      } catch (err) {
        await this.d.syncLog.write({
          jobId: job.id,
          entityKey: job.entityKey,
          level: 'warn',
          message: `No se pudo guardar el ID en WooCommerce: ${errorMessage(err)}`,
        });
      }
    }

    await this.d.syncLog.write({
      jobId: job.id,
      entityKey: job.entityKey,
      level: 'info',
      message: result.alreadyExisted
        ? `Ya existía en ${this.d.target.name} (id ${result.targetId})`
        : `Creado en ${this.d.target.name} (id ${result.targetId})`,
    });
  }
}

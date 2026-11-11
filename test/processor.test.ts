import { describe, expect, it, vi } from 'vitest';
import { PermanentError, RetryableError } from '../src/core/errors.js';
import { JOB_WOO_ORDER, JobProcessor } from '../src/core/processor.js';
import { backoffSeconds } from '../src/core/queue.js';
import type { TargetAdapter } from '../src/core/target.js';
import { wooOrderToOrder } from '../src/sources/woo/mapper.js';
import fixture from './fixtures/woo-order.json' with { type: 'json' };
import { MemoryQueue, MemorySyncLog, silentLog } from './helpers.js';

function setup(target: TargetAdapter, maxAttempts = 3) {
  const queue = new MemoryQueue();
  const syncLog = new MemorySyncLog();
  const notifier = { alert: vi.fn(async () => {}) };
  const woo = { setOrderMeta: vi.fn(async () => {}) };
  const processor = new JobProcessor({
    queue,
    target,
    syncLog,
    woo,
    notifier,
    log: silentLog,
    parseOrder: (p) => wooOrderToOrder(p, { vatMetaKeys: [] }),
    options: {
      syncStatuses: ['processing', 'completed'],
      maxAttempts,
      batchSize: 20,
      timeBudgetMs: 5_000,
    },
  });
  return { queue, syncLog, notifier, woo, processor };
}

const enqueueFixture = (queue: MemoryQueue, status = 'processing') =>
  queue.enqueue({
    type: JOB_WOO_ORDER,
    dedupeKey: `woo:order:${fixture.id}:${status}`,
    entityKey: `order:${fixture.id}`,
    payload: { ...fixture, status },
  });

describe('JobProcessor', () => {
  it('envía el pedido al destino y guarda el id en WooCommerce', async () => {
    const target: TargetAdapter = {
      name: 'odoo',
      ping: async () => {},
      upsertOrder: vi.fn(async () => ({ targetId: '77', alreadyExisted: false, warnings: [] })),
    };
    const { queue, woo, processor } = setup(target);
    await enqueueFixture(queue);

    const summary = await processor.run();

    expect(summary).toMatchObject({ claimed: 1, done: 1, dead: 0 });
    expect(target.upsertOrder).toHaveBeenCalledOnce();
    expect(woo.setOrderMeta).toHaveBeenCalledWith('4521', '_odoo_id', '77');
    expect(queue.byId(1).status).toBe('done');
  });

  it('reintenta errores temporales y luego tiene éxito', async () => {
    const upsert = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('Odoo no responde'))
      .mockResolvedValueOnce({ targetId: '77', alreadyExisted: false, warnings: [] });
    const { queue, processor } = setup({ name: 'odoo', ping: async () => {}, upsertOrder: upsert });
    await enqueueFixture(queue);

    expect(await processor.run()).toMatchObject({ retried: 1 });
    expect(queue.byId(1).status).toBe('failed');
    expect(await processor.run()).toMatchObject({ claimed: 0 }); // todavía en espera

    queue.fastForward();
    expect(await processor.run()).toMatchObject({ done: 1 });
  });

  it('marca dead y alerta ante errores de datos, sin reintentar', async () => {
    const { queue, notifier, processor } = setup({
      name: 'odoo',
      ping: async () => {},
      upsertOrder: async () => {
        throw new PermanentError('SKU no encontrado en Odoo: X');
      },
    });
    await enqueueFixture(queue);

    expect(await processor.run()).toMatchObject({ dead: 1 });
    expect(queue.byId(1).status).toBe('dead');
    expect(notifier.alert).toHaveBeenCalledOnce();
  });

  it('marca dead tras agotar los intentos', async () => {
    const { queue, processor } = setup(
      {
        name: 'odoo',
        ping: async () => {},
        upsertOrder: async () => {
          throw new RetryableError('timeout');
        },
      },
      2,
    );
    await enqueueFixture(queue);
    await processor.run();
    queue.fastForward();
    await processor.run();
    expect(queue.byId(1).status).toBe('dead');
  });

  it('no vuelve a escribir en WooCommerce si el pedido ya existía', async () => {
    const { queue, woo, processor } = setup({
      name: 'odoo',
      ping: async () => {},
      upsertOrder: async () => ({ targetId: '77', alreadyExisted: true, warnings: [] }),
    });
    await enqueueFixture(queue);
    await processor.run();
    expect(woo.setOrderMeta).not.toHaveBeenCalled();
  });
});

describe('backoff', () => {
  it('crece: 5 min, 15 min, 1 h…', () => {
    expect(backoffSeconds(1)).toBe(300);
    expect(backoffSeconds(2)).toBe(900);
    expect(backoffSeconds(3)).toBe(3600);
    expect(backoffSeconds(99)).toBe(6 * 3600);
  });
});

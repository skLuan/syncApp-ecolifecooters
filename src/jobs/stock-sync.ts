import { errorMessage } from '../core/errors.js';
import type { IdMap, StateStore, SyncLog } from '../core/store.js';
import type { TargetAdapter } from '../core/target.js';
import type { WooClient } from '../sources/woo/client.js';

const CURSOR_KEY = 'stock.cursor';
/** En la primera ejecución, mirar las últimas 24 h. */
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface StockSyncDeps {
  target: TargetAdapter;
  woo: WooClient;
  idMap: IdMap;
  state: StateStore;
  syncLog: SyncLog;
}

export interface StockSyncSummary {
  changed: number;
  updated: number;
  notInWoo: string[];
}

/**
 * Stock Odoo → WooCommerce. Se ejecuta dentro de /jobs/run cuando STOCK_SYNC_ENABLED=true.
 * Solo toca stock, nunca precios (fuera de alcance v1).
 */
export async function runStockSync(d: StockSyncDeps): Promise<StockSyncSummary> {
  if (!d.target.fetchStockChanges) return { changed: 0, updated: 0, notInWoo: [] };

  const saved = await d.state.get(CURSOR_KEY);
  const since = saved ? new Date(saved) : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);
  const { levels, cursor } = await d.target.fetchStockChanges(since);

  const simple: { id: number; stock: number }[] = [];
  const variations = new Map<number, { id: number; stock: number }[]>();
  const notInWoo: string[] = [];

  for (const level of levels) {
    let ref = await d.idMap.get('product', 'sku', level.sku, 'woocommerce');
    if (!ref) {
      const found = await d.woo.findProductBySku(level.sku);
      if (!found) {
        notInWoo.push(level.sku);
        continue;
      }
      ref = { targetId: String(found.id), extra: { parentId: found.parentId } };
      await d.idMap.set('product', 'sku', level.sku, 'woocommerce', ref);
    }
    const id = Number(ref.targetId);
    const parentId = Number(ref.extra?.parentId ?? 0);
    if (parentId) {
      const list = variations.get(parentId) ?? [];
      list.push({ id, stock: level.quantity });
      variations.set(parentId, list);
    } else {
      simple.push({ id, stock: level.quantity });
    }
  }

  for (let i = 0; i < simple.length; i += 100) {
    await d.woo.updateSimpleStock(simple.slice(i, i + 100));
  }
  for (const [parentId, items] of variations) {
    await d.woo.updateVariationStock(parentId, items);
  }

  if (notInWoo.length) {
    await d.syncLog.write({
      entityKey: 'stock',
      level: 'warn',
      message: `SKU con stock en Odoo que no existen en WooCommerce: ${notInWoo.join(', ')}`,
    });
  }

  await d.state.set(CURSOR_KEY, cursor.toISOString());
  const updated = simple.length + [...variations.values()].reduce((n, l) => n + l.length, 0);
  return { changed: levels.length, updated, notInWoo };
}

/** Envoltorio que nunca lanza: un fallo de stock no debe bloquear los pedidos. */
export async function runStockSyncSafe(d: StockSyncDeps) {
  try {
    return { ok: true as const, ...(await runStockSync(d)) };
  } catch (err) {
    const message = errorMessage(err);
    await d.syncLog.write({ entityKey: 'stock', level: 'error', message }).catch(() => {});
    return { ok: false as const, error: message };
  }
}

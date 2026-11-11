import { describe, expect, it } from 'vitest';
import { PermanentError } from '../src/core/errors.js';
import { wooOrderToOrder } from '../src/sources/woo/mapper.js';
import { OdooAdapter } from '../src/targets/odoo/adapter.js';
import type { OdooTransport } from '../src/targets/odoo/transport.js';
import fixture from './fixtures/woo-order.json' with { type: 'json' };
import { MemoryIdMap } from './helpers.js';

type Call = { model: string; method: string; params: Record<string, unknown>; ids?: number[] };

/** Odoo falso: registra llamadas y responde lo mínimo. */
class FakeOdoo implements OdooTransport {
  calls: Call[] = [];
  products = new Map([
    ['VIN-M41-CLAW-ROJO-COMP', 11],
    ['CASCO-INTEGRA-NEG', 12],
    ['ENVIO', 99],
  ]);
  existingOrderRef: string | null = null;
  amountTotal = 120.8;

  async call<T>(
    model: string,
    method: string,
    params: Record<string, unknown> = {},
    ids?: number[],
  ) {
    this.calls.push({ model, method, params, ids });
    const key = `${model}.${method}`;
    const domain = (params.domain ?? []) as [string, string, unknown][];
    switch (key) {
      case 'sale.order.search_read':
        return (
          this.existingOrderRef && domain[0]?.[2] === this.existingOrderRef ? [{ id: 500 }] : []
        ) as T;
      case 'product.product.search_read': {
        const skus = domain[0]?.[2] as string[];
        return skus
          .filter((s) => this.products.has(s))
          .map((s) => ({ id: this.products.get(s), default_code: s })) as T;
      }
      case 'res.country.search_read':
        return [{ id: 68 }] as T;
      case 'res.partner.search_read':
        return [] as T;
      case 'res.partner.create':
        return [this.calls.filter((c) => c.method === 'create').length + 200] as T;
      case 'sale.order.create':
        return [501] as T;
      case 'sale.order.read':
        return [{ amount_total: this.amountTotal }] as T;
      default:
        return true as T;
    }
  }
}

const opts = {
  confirmOrders: false,
  shippingProductSku: 'ENVIO',
  feeProductSku: 'CARGO',
  orderRefPrefix: 'WEB-',
};
const order = wooOrderToOrder(fixture, { vatMetaKeys: ['_billing_nif'] });

describe('OdooAdapter.upsertOrder', () => {
  it('crea cliente, dirección de envío y pedido con líneas sin IVA y envío', async () => {
    const odoo = new FakeOdoo();
    const idMap = new MemoryIdMap();
    const res = await new OdooAdapter(odoo, idMap, opts).upsertOrder(order);

    expect(res).toEqual({ targetId: '501', alreadyExisted: false, warnings: [] });
    const create = odoo.calls.find((c) => c.model === 'sale.order' && c.method === 'create');
    const vals = ((create?.params.vals_list ?? []) as Record<string, unknown>[])[0];
    expect(vals).toMatchObject({ client_order_ref: 'WEB-4521', date_order: '2026-11-27 10:15:00' });
    const lines = vals?.order_line as [0, 0, Record<string, unknown>][];
    expect(lines.map((l) => l[2].product_id)).toEqual([11, 12, 99]);
    expect(lines[0]?.[2].price_unit).toBe(49.51);
    expect(String(vals?.note)).toContain('stripe');
    expect(await idMap.get('order', 'woocommerce', '4521', 'odoo')).toEqual({ targetId: '501' });
  });

  it('es idempotente: no crea nada si el pedido ya existe en Odoo', async () => {
    const odoo = new FakeOdoo();
    odoo.existingOrderRef = 'WEB-4521';
    const res = await new OdooAdapter(odoo, new MemoryIdMap(), opts).upsertOrder(order);
    expect(res).toMatchObject({ targetId: '500', alreadyExisted: true });
    expect(odoo.calls.some((c) => c.method === 'create')).toBe(false);
  });

  it('no crea nada si falta un SKU en Odoo', async () => {
    const odoo = new FakeOdoo();
    odoo.products.delete('CASCO-INTEGRA-NEG');
    await expect(new OdooAdapter(odoo, new MemoryIdMap(), opts).upsertOrder(order)).rejects.toThrow(
      PermanentError,
    );
    expect(odoo.calls.some((c) => c.method === 'create')).toBe(false);
  });

  it('avisa si el total de Odoo no coincide con lo cobrado', async () => {
    const odoo = new FakeOdoo();
    odoo.amountTotal = 120.7;
    const res = await new OdooAdapter(odoo, new MemoryIdMap(), opts).upsertOrder(order);
    expect(res.warnings[0]).toMatch(/Total distinto/);
  });

  it('confirma el pedido si ODOO_CONFIRM_ORDERS=true', async () => {
    const odoo = new FakeOdoo();
    await new OdooAdapter(odoo, new MemoryIdMap(), { ...opts, confirmOrders: true }).upsertOrder(
      order,
    );
    expect(odoo.calls.find((c) => c.method === 'action_confirm')?.ids).toEqual([501]);
  });
});

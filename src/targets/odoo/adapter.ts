import { PermanentError } from '../../core/errors.js';
import type { Address, Customer, Order, StockLevel } from '../../core/model.js';
import type { IdMap } from '../../core/store.js';
import type { TargetAdapter, UpsertResult } from '../../core/target.js';
import type { OdooTransport } from './transport.js';

export interface OdooAdapterOptions {
  confirmOrders: boolean;
  shippingProductSku: string;
  feeProductSku: string;
  orderRefPrefix: string;
  stockLocationId?: number;
}

const TARGET = 'odoo';
const SOURCE = 'woocommerce';

type Domain = unknown[];
type Line = [0, 0, Record<string, unknown>];

/** "2026-11-10T12:30:00Z" → "2026-11-10 12:30:00" (formato de Odoo, UTC) */
export function toOdooDatetime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function fromOdooDatetime(s: string): Date {
  return new Date(`${s.replace(' ', 'T')}Z`);
}

/** Número de nuevo registro: JSON-2 y JSON-RPC pueden devolver id o [id]. */
function firstId(result: number | number[]): number {
  const id = Array.isArray(result) ? result[0] : result;
  if (typeof id !== 'number')
    throw new Error(`Odoo devolvió un id inesperado: ${JSON.stringify(result)}`);
  return id;
}

export class OdooAdapter implements TargetAdapter {
  readonly name = TARGET;
  private countryCache = new Map<string, number | false>();

  constructor(
    private readonly odoo: OdooTransport,
    private readonly idMap: IdMap,
    private readonly opts: OdooAdapterOptions,
  ) {}

  async ping(): Promise<void> {
    await this.odoo.call('res.users', 'search_read', {
      domain: [],
      fields: ['id'],
      limit: 1,
    });
  }

  // ---------------------------------------------------------------- pedidos

  async upsertOrder(order: Order): Promise<UpsertResult> {
    const warnings: string[] = [];
    const ref = `${this.opts.orderRefPrefix}${order.number}`;

    // 1) ¿Ya lo sincronizamos? (id_map)
    const mapped = await this.idMap.get('order', SOURCE, order.externalId, TARGET);
    if (mapped) return { targetId: mapped.targetId, alreadyExisted: true, warnings };

    // 2) ¿Existe en Odoo aunque no esté en id_map? (caída entre crear y guardar el mapeo)
    const existing = await this.searchRead<{ id: number }>(
      'sale.order',
      [['client_order_ref', '=', ref]],
      ['id'],
      1,
    );
    if (existing[0]) {
      await this.idMap.set('order', SOURCE, order.externalId, TARGET, {
        targetId: String(existing[0].id),
      });
      return { targetId: String(existing[0].id), alreadyExisted: true, warnings };
    }

    // 3) Productos por SKU (referencia interna). Si falta uno, no se crea nada.
    const products = await this.resolveProducts(order);

    // 4) Cliente y dirección de envío
    const partnerId = await this.upsertPartner(order.customer);
    const shippingId = order.customer.shipping
      ? await this.createDeliveryAddress(partnerId, order.customer.shipping, order.customer)
      : partnerId;

    // 5) Líneas. Precios SIN IVA: Odoo aplica los impuestos configurados en cada producto.
    const lines: Line[] = order.lines.map((l) => [
      0,
      0,
      {
        product_id: products.get(l.sku),
        name: l.name,
        product_uom_qty: l.quantity,
        price_unit: l.quantity ? l.totalExclTax / l.quantity : 0,
      },
    ]);
    for (const s of order.shipping) {
      lines.push([
        0,
        0,
        {
          product_id: products.get(this.opts.shippingProductSku),
          name: s.name,
          product_uom_qty: 1,
          price_unit: s.totalExclTax,
        },
      ]);
    }
    for (const f of order.fees) {
      lines.push([
        0,
        0,
        {
          product_id: products.get(this.opts.feeProductSku),
          name: f.name,
          product_uom_qty: 1,
          price_unit: f.totalExclTax,
        },
      ]);
    }

    const note = [
      `Pedido web #${order.number}`,
      `Pasarela: ${order.payment.title || order.payment.method} (${order.payment.method})`,
      order.payment.transactionId ? `Transacción: ${order.payment.transactionId}` : null,
      order.coupons.length ? `Cupones: ${order.coupons.join(', ')}` : null,
      order.customerNote ? `Nota del cliente: ${order.customerNote}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    // 6) Crear pedido y guardar el mapeo ANTES de cualquier otro paso
    const created = await this.odoo.call<number | number[]>('sale.order', 'create', {
      vals_list: [
        {
          partner_id: partnerId,
          partner_invoice_id: partnerId,
          partner_shipping_id: shippingId,
          client_order_ref: ref,
          origin: `WooCommerce #${order.number}`,
          date_order: toOdooDatetime(order.createdAt),
          note,
          order_line: lines,
        },
      ],
    });
    const saleId = firstId(created);
    await this.idMap.set('order', SOURCE, order.externalId, TARGET, { targetId: String(saleId) });

    // 7) Confirmar (opcional)
    if (this.opts.confirmOrders) {
      await this.odoo.call('sale.order', 'action_confirm', {}, [saleId]);
    }

    // 8) Control de totales: el total de Odoo debe coincidir con lo cobrado
    const [saved] = await this.odoo.call<{ amount_total: number }[]>(
      'sale.order',
      'read',
      { fields: ['amount_total'] },
      [saleId],
    );
    const diff = Math.abs((saved?.amount_total ?? 0) - order.total);
    if (diff > 0.01) {
      warnings.push(
        `Total distinto: Odoo ${saved?.amount_total} vs WooCommerce ${order.total} (dif. ${diff.toFixed(2)}). Revisar impuestos/redondeo.`,
      );
    }

    return { targetId: String(saleId), alreadyExisted: false, warnings };
  }

  // ---------------------------------------------------------------- stock

  async fetchStockChanges(since: Date): Promise<{ levels: StockLevel[]; cursor: Date }> {
    const domain: Domain = [
      ['write_date', '>', toOdooDatetime(since)],
      ['location_id.usage', '=', 'internal'],
    ];
    if (this.opts.stockLocationId)
      domain.push(['location_id', 'child_of', this.opts.stockLocationId]);

    const quants = await this.searchRead<{ product_id: [number, string]; write_date: string }>(
      'stock.quant',
      domain,
      ['product_id', 'write_date'],
    );
    if (quants.length === 0) return { levels: [], cursor: since };

    const cursor = new Date(
      Math.max(since.getTime(), ...quants.map((q) => fromOdooDatetime(q.write_date).getTime())),
    );

    const productIds = [...new Set(quants.map((q) => q.product_id[0]))];
    const context = this.opts.stockLocationId ? { location: this.opts.stockLocationId } : undefined;
    // free_qty = disponible (a mano − reservado). Ver README: requiere confirmar pedidos en Odoo.
    const products = await this.odoo.call<{ default_code: string | false; free_qty: number }[]>(
      'product.product',
      'read',
      { fields: ['default_code', 'free_qty'], ...(context ? { context } : {}) },
      productIds,
    );

    const levels = products
      .filter((p): p is { default_code: string; free_qty: number } => Boolean(p.default_code))
      .map((p) => ({ sku: p.default_code, quantity: Math.max(0, Math.floor(p.free_qty)) }));

    return { levels, cursor };
  }

  // ---------------------------------------------------------------- helpers

  private searchRead<T>(model: string, domain: Domain, fields: string[], limit?: number) {
    return this.odoo.call<T[]>(model, 'search_read', {
      domain,
      fields,
      ...(limit ? { limit } : {}),
    });
  }

  private async resolveProducts(order: Order): Promise<Map<string, number>> {
    const skus = new Set(order.lines.map((l) => l.sku));
    if (order.shipping.length) skus.add(this.opts.shippingProductSku);
    if (order.fees.length) skus.add(this.opts.feeProductSku);

    const found = await this.searchRead<{ id: number; default_code: string }>(
      'product.product',
      [['default_code', 'in', [...skus]]],
      ['id', 'default_code'],
    );
    const map = new Map(found.map((p) => [p.default_code, p.id]));
    const missing = [...skus].filter((s) => !map.has(s));
    if (missing.length) {
      throw new PermanentError(
        `SKU no encontrado en Odoo (Referencia interna): ${missing.join(', ')}. Créalo o corrige el SKU y reintenta.`,
      );
    }
    return map;
  }

  private async countryId(code: string): Promise<number | false> {
    if (!code) return false;
    const cached = this.countryCache.get(code);
    if (cached !== undefined) return cached;
    const rows = await this.searchRead<{ id: number }>(
      'res.country',
      [['code', '=', code]],
      ['id'],
      1,
    );
    const id = rows[0]?.id ?? false;
    this.countryCache.set(code, id);
    return id;
  }

  private async addressVals(a: Address) {
    return {
      street: a.line1 || false,
      street2: a.line2 || false,
      city: a.city || false,
      zip: a.postcode || false,
      country_id: await this.countryId(a.country),
    };
  }

  /** Busca el cliente por email; si no existe, lo crea. Nunca sobrescribe datos editados en Odoo. */
  private async upsertPartner(c: Customer): Promise<number> {
    const mapped = await this.idMap.get('customer', SOURCE, c.email, TARGET);
    if (mapped) return Number(mapped.targetId);

    const found = await this.searchRead<{ id: number }>(
      'res.partner',
      [
        ['email', '=ilike', c.email],
        ['parent_id', '=', false],
      ],
      ['id'],
      1,
    );
    let id = found[0]?.id;
    if (!id) {
      const created = await this.odoo.call<number | number[]>('res.partner', 'create', {
        vals_list: [
          {
            name: c.billing.company || c.name,
            is_company: Boolean(c.billing.company),
            email: c.email,
            phone: c.phone || false,
            vat: c.vat || false,
            ...(await this.addressVals(c.billing)),
          },
        ],
      });
      id = firstId(created);
    }
    await this.idMap.set('customer', SOURCE, c.email, TARGET, { targetId: String(id) });
    return id;
  }

  /** Reutiliza la dirección de envío si el cliente ya la tiene; si no, la crea. */
  private async createDeliveryAddress(parentId: number, a: Address, c: Customer): Promise<number> {
    const existing = await this.searchRead<{ id: number }>(
      'res.partner',
      [
        ['parent_id', '=', parentId],
        ['type', '=', 'delivery'],
        ['street', '=ilike', a.line1],
        ['zip', '=', a.postcode],
      ],
      ['id'],
      1,
    );
    if (existing[0]) return existing[0].id;

    const created = await this.odoo.call<number | number[]>('res.partner', 'create', {
      vals_list: [
        {
          parent_id: parentId,
          type: 'delivery',
          name: `${a.firstName} ${a.lastName}`.trim() || c.name,
          phone: a.phone || c.phone || false,
          ...(await this.addressVals(a)),
        },
      ],
    });
    return firstId(created);
  }
}

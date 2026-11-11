import { PermanentError } from '../../core/errors.js';
import type { Address, ChargeLine, Order } from '../../core/model.js';
import { type WooAddress, type WooOrder, WooOrderSchema } from './types.js';

export const round2 = (n: number) => Math.round(n * 100) / 100;

function toAddress(a: WooAddress): Address {
  return {
    firstName: a.first_name,
    lastName: a.last_name,
    company: a.company || undefined,
    line1: a.address_1,
    line2: a.address_2 || undefined,
    city: a.city,
    postcode: a.postcode,
    state: a.state || undefined,
    country: a.country.toUpperCase(),
    phone: a.phone || undefined,
    email: a.email || undefined,
  };
}

function sameAddress(a: WooAddress, b: WooAddress): boolean {
  const keys = [
    'first_name',
    'last_name',
    'address_1',
    'address_2',
    'city',
    'postcode',
    'country',
  ] as const;
  return keys.every((k) => a[k].toLowerCase() === b[k].toLowerCase());
}

function findVat(order: WooOrder, metaKeys: string[]): string | undefined {
  for (const key of metaKeys) {
    const meta = order.meta_data.find((m) => m.key === key);
    if (typeof meta?.value === 'string' && meta.value.trim())
      return meta.value.trim().toUpperCase();
  }
  return undefined;
}

/** Convierte el JSON crudo del webhook/REST de WooCommerce al modelo común. */
export function wooOrderToOrder(raw: unknown, opts: { vatMetaKeys: string[] }): Order {
  const parsed = WooOrderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PermanentError(`Pedido WooCommerce con formato inesperado: ${parsed.error.message}`);
  }
  const o = parsed.data;

  const email = (o.billing.email ?? '').toLowerCase();
  if (!email) throw new PermanentError(`Pedido ${o.number} sin email de facturación`);

  const billing = toAddress(o.billing);
  const hasShipping = o.shipping.address_1 !== '' && !sameAddress(o.billing, o.shipping);
  const name =
    `${o.billing.first_name} ${o.billing.last_name}`.trim() || o.billing.company || email;

  const charge = (name: string, total: number, tax: number): ChargeLine => ({
    name,
    totalExclTax: round2(total),
    totalTax: round2(tax),
  });

  return {
    source: 'woocommerce',
    externalId: String(o.id),
    number: o.number,
    status: o.status,
    currency: o.currency,
    createdAt: o.date_created_gmt ? `${o.date_created_gmt}Z` : new Date().toISOString(),
    customer: {
      externalId: o.customer_id ? String(o.customer_id) : undefined,
      email,
      name,
      phone: o.billing.phone || undefined,
      vat: findVat(o, opts.vatMetaKeys),
      billing,
      shipping: hasShipping ? toAddress(o.shipping) : undefined,
    },
    lines: o.line_items.map((li) => ({
      externalId: String(li.id),
      sku: li.sku,
      name: li.name,
      quantity: li.quantity,
      totalExclTax: round2(li.total),
      totalTax: round2(li.total_tax),
    })),
    shipping: o.shipping_lines
      .filter((s) => s.total !== 0 || s.total_tax !== 0)
      .map((s) => charge(s.method_title || 'Envío', s.total, s.total_tax)),
    fees: o.fee_lines.map((f) => charge(f.name || 'Cargo', f.total, f.total_tax)),
    coupons: o.coupon_lines.map((c) => c.code).filter(Boolean),
    payment: {
      method: o.payment_method,
      title: o.payment_method_title,
      transactionId: o.transaction_id || undefined,
    },
    discountTotal: round2(o.discount_total),
    totalTax: round2(o.total_tax),
    total: round2(o.total),
    customerNote: o.customer_note || undefined,
  };
}

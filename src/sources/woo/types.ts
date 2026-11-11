import { z } from 'zod';

/**
 * Subconjunto del pedido de WooCommerce REST v3 que usamos.
 * Los importes llegan como string ("82.64"). Los campos desconocidos se ignoran.
 */

const money = z.union([z.string(), z.number()]).transform((v) => Number(v) || 0);
const str = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v ?? '').toString().trim());

const WooAddress = z.object({
  first_name: str,
  last_name: str,
  company: str,
  address_1: str,
  address_2: str,
  city: str,
  state: str,
  postcode: str,
  country: str,
  email: str.optional(),
  phone: str.optional(),
});

const WooMeta = z.object({
  key: z.string(),
  value: z.unknown(),
});

export const WooOrderSchema = z.object({
  id: z.number(),
  number: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  currency: z.string(),
  date_created_gmt: str,
  customer_id: z.number().default(0),
  customer_note: str,
  discount_total: money,
  total: money,
  total_tax: money,
  payment_method: str,
  payment_method_title: str,
  transaction_id: str,
  billing: WooAddress,
  shipping: WooAddress,
  line_items: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      product_id: z.number(),
      variation_id: z.number().default(0),
      quantity: z.number(),
      total: money,
      total_tax: money,
      sku: str,
    }),
  ),
  shipping_lines: z
    .array(z.object({ method_title: str, total: money, total_tax: money }))
    .default([]),
  fee_lines: z.array(z.object({ name: str, total: money, total_tax: money })).default([]),
  coupon_lines: z.array(z.object({ code: str })).default([]),
  meta_data: z.array(WooMeta).default([]),
});

export type WooOrder = z.infer<typeof WooOrderSchema>;
export type WooAddress = z.infer<typeof WooAddress>;

/**
 * Modelo común. El núcleo y los adaptadores SOLO hablan en estos tipos.
 * Las fuentes (WooCommerce) traducen hacia aquí; los destinos (Odoo, Zoho…) traducen desde aquí.
 * Importes en unidades monetarias (no céntimos), ya redondeados a 2 decimales.
 */

export interface Address {
  firstName: string;
  lastName: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  state?: string;
  /** Código ISO 3166-1 alfa-2, ej. "ES" */
  country: string;
  phone?: string;
  email?: string;
}

export interface Customer {
  /** ID del cliente en la fuente (0/undefined = invitado) */
  externalId?: string;
  email: string;
  name: string;
  phone?: string;
  /** NIF / CIF / VAT */
  vat?: string;
  billing: Address;
  /** Solo si es distinta de la de facturación */
  shipping?: Address;
}

export interface OrderLine {
  externalId: string;
  sku: string;
  name: string;
  quantity: number;
  /** Total de la línea sin impuestos, YA con descuentos/cupones aplicados */
  totalExclTax: number;
  totalTax: number;
}

export interface ChargeLine {
  name: string;
  totalExclTax: number;
  totalTax: number;
}

export interface Payment {
  /** id técnico de la pasarela: "stripe", "viabill"… */
  method: string;
  title: string;
  transactionId?: string;
}

export interface Order {
  source: 'woocommerce';
  externalId: string;
  number: string;
  status: string;
  currency: string;
  createdAt: string;
  customer: Customer;
  lines: OrderLine[];
  shipping: ChargeLine[];
  fees: ChargeLine[];
  coupons: string[];
  payment: Payment;
  discountTotal: number;
  totalTax: number;
  total: number;
  customerNote?: string;
}

export interface StockLevel {
  sku: string;
  quantity: number;
}

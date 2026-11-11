import { describe, expect, it } from 'vitest';
import { PermanentError } from '../src/core/errors.js';
import { assertOrderSyncable } from '../src/core/validate.js';
import { wooOrderToOrder } from '../src/sources/woo/mapper.js';
import fixture from './fixtures/woo-order.json' with { type: 'json' };

const opts = { vatMetaKeys: ['_billing_nif'] };

describe('WooCommerce → modelo común', () => {
  const order = wooOrderToOrder(fixture, opts);

  it('mapea cabecera, pago y totales', () => {
    expect(order.externalId).toBe('4521');
    expect(order.status).toBe('processing');
    expect(order.total).toBe(120.8);
    expect(order.payment).toEqual({
      method: 'stripe',
      title: 'Tarjeta de crédito/débito',
      transactionId: 'pi_3QabcXYZ',
    });
    expect(order.createdAt).toBe('2026-11-27T10:15:00Z');
    expect(order.coupons).toEqual(['blackfriday10']);
  });

  it('normaliza el cliente: email en minúsculas, NIF y dirección de envío distinta', () => {
    expect(order.customer.email).toBe('laura.garcia@example.com');
    expect(order.customer.name).toBe('Laura García');
    expect(order.customer.vat).toBe('12345678Z');
    expect(order.customer.shipping?.city).toBe('Getafe');
  });

  it('usa el total de línea con descuento aplicado y sin IVA', () => {
    expect(order.lines).toHaveLength(2);
    expect(order.lines[0]).toMatchObject({
      sku: 'VIN-M41-CLAW-ROJO-COMP',
      quantity: 1,
      totalExclTax: 49.51,
    });
    expect(order.shipping).toEqual([
      { name: 'Envío estándar', totalExclTax: 4.95, totalTax: 1.04 },
    ]);
  });

  it('omite la dirección de envío si es igual a la de facturación', () => {
    const same = { ...fixture, shipping: { ...fixture.billing } };
    expect(wooOrderToOrder(same, opts).customer.shipping).toBeUndefined();
  });

  it('falla de forma permanente sin email o con productos sin SKU', () => {
    const noEmail = { ...fixture, billing: { ...fixture.billing, email: '' } };
    expect(() => wooOrderToOrder(noEmail, opts)).toThrow(PermanentError);

    const noSku = {
      ...fixture,
      line_items: [{ ...fixture.line_items[0], sku: '' }],
    };
    expect(() => assertOrderSyncable(wooOrderToOrder(noSku, opts))).toThrow(/sin SKU/);
  });
});

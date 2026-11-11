import type { Config } from '../config.js';
import type { IdMap } from '../core/store.js';
import type { TargetAdapter } from '../core/target.js';
import { OdooAdapter } from './odoo/adapter.js';
import { createTransport } from './odoo/transport.js';

/**
 * Registro de destinos. Para sumar Zoho:
 *   1. crear src/targets/zoho-books/adapter.ts que implemente TargetAdapter
 *   2. añadir el valor a TARGET en config.ts
 *   3. añadir el case aquí
 * El núcleo no cambia.
 */
export function createTarget(config: Config, idMap: IdMap): TargetAdapter {
  switch (config.TARGET) {
    case 'odoo':
      return new OdooAdapter(
        createTransport(config.ODOO_API, {
          url: config.ODOO_URL,
          db: config.ODOO_DB,
          login: config.ODOO_LOGIN,
          apiKey: config.ODOO_API_KEY,
        }),
        idMap,
        {
          confirmOrders: config.ODOO_CONFIRM_ORDERS,
          shippingProductSku: config.ODOO_SHIPPING_PRODUCT_SKU,
          feeProductSku: config.ODOO_FEE_PRODUCT_SKU,
          orderRefPrefix: config.ODOO_ORDER_REF_PREFIX,
          stockLocationId: config.ODOO_STOCK_LOCATION_ID,
        },
      );
  }
}

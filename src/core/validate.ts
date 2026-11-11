import { PermanentError } from './errors.js';
import type { Order } from './model.js';

/** Reglas que valen para CUALQUIER destino. Las específicas van en cada adaptador. */
export function assertOrderSyncable(order: Order): void {
  if (order.lines.length === 0) {
    throw new PermanentError(`Pedido ${order.number} sin líneas de producto`);
  }
  const withoutSku = order.lines.filter((l) => !l.sku);
  if (withoutSku.length) {
    throw new PermanentError(
      `Pedido ${order.number}: productos sin SKU en WooCommerce: ${withoutSku.map((l) => l.name).join(', ')}`,
    );
  }
  if (order.lines.some((l) => l.quantity <= 0)) {
    throw new PermanentError(`Pedido ${order.number}: cantidad inválida en alguna línea`);
  }
}

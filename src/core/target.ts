import type { Order, StockLevel } from './model.js';

export interface UpsertResult {
  /** ID del registro en el destino */
  targetId: string;
  /** true si ya existía (no se creó nada nuevo) */
  alreadyExisted: boolean;
  /** Avisos no bloqueantes (ej. diferencia de céntimos en el total) */
  warnings: string[];
}

/**
 * Contrato que cumple cada destino (Odoo, Zoho Books, Zoho CRM…).
 * El núcleo no importa nada de un adaptador concreto: lo recibe por configuración.
 */
export interface TargetAdapter {
  readonly name: string;

  /** Comprueba credenciales y conectividad. */
  ping(): Promise<void>;

  /**
   * Crea el pedido (y el cliente si hace falta). DEBE ser idempotente:
   * llamarlo dos veces con el mismo pedido no puede crear dos registros.
   */
  upsertOrder(order: Order): Promise<UpsertResult>;

  /** Niveles de stock cambiados desde `since`. Opcional: no todos los destinos tienen inventario. */
  fetchStockChanges?(since: Date): Promise<{ levels: StockLevel[]; cursor: Date }>;
}

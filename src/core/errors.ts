/**
 * Error temporal: se reintenta con espera creciente (Odoo caído, timeout, 5xx…).
 */
export class RetryableError extends Error {
  override name = 'RetryableError';
}

/**
 * Error de datos: reintentar no sirve hasta que alguien corrija algo
 * (SKU inexistente, payload inválido…). El job pasa directo a "dead" y se alerta.
 */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WooCommerce firma cada webhook con:
 *   X-WC-Webhook-Signature = base64( HMAC-SHA256( cuerpo crudo, secreto ) )
 * Hay que calcularlo sobre los bytes EXACTOS recibidos, antes de parsear el JSON.
 */
export function signWooPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

export function verifyWooSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signWooPayload(rawBody, secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

import { describe, expect, it } from 'vitest';
import { signWooPayload, verifyWooSignature } from '../src/sources/woo/signature.js';

describe('firma de webhooks WooCommerce', () => {
  const secret = 'super-secreto';
  const body = Buffer.from('{"id":1,"status":"processing"}');

  it('acepta una firma correcta', () => {
    expect(verifyWooSignature(body, signWooPayload(body, secret), secret)).toBe(true);
  });

  it('rechaza firma ausente, de otro secreto o cuerpo alterado', () => {
    expect(verifyWooSignature(body, undefined, secret)).toBe(false);
    expect(verifyWooSignature(body, signWooPayload(body, 'otro'), secret)).toBe(false);
    const altered = Buffer.from('{"id":1,"status":"completed"}');
    expect(verifyWooSignature(altered, signWooPayload(body, secret), secret)).toBe(false);
  });
});

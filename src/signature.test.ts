/**
 * The signature only works if **the server and the bot runtime compute the same value.**
 *
 * The two implementations deliberately do not import each other: the server pulling in this package
 * would blur the line that keeps it a relay and nothing more. Instead both sides pin **the same
 * fixed vector**, so changing the algorithm breaks both tests at once.
 */
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature, webhookSigningKey } from './signature';
import { createHmac } from 'node:crypto';

const SECRET = 'test-secret';
const T = 1_700_000_000;
const BODY = '{"botId":"b","items":[]}';
/** The same value the server's own signature test pins. */
const VECTOR = '97e0c9ab16c9698d7d8b62875e857cefef01def27a5d95e38fdecda714318a52';

describe('webhook signature', () => {
  it('matches the fixed vector, so both implementations agree', () => {
    const mac = createHmac('sha256', webhookSigningKey(SECRET)).update(`${T}.${BODY}`).digest('hex');
    expect(mac).toBe(VECTOR);
  });

  it('accepts only a correct signature', () => {
    expect(verifyWebhookSignature(SECRET, `t=${T},v1=${VECTOR}`, BODY, T)).toBe(true);
    expect(verifyWebhookSignature(SECRET, `t=${T},v1=${VECTOR}`, `${BODY} `, T)).toBe(false);
    expect(verifyWebhookSignature('other-secret', `t=${T},v1=${VECTOR}`, BODY, T)).toBe(false);
    expect(verifyWebhookSignature(SECRET, undefined, BODY, T)).toBe(false);
    expect(verifyWebhookSignature(SECRET, 'garbage', BODY, T)).toBe(false);
  });

  it('treats a timestamp outside the tolerance as a replay', () => {
    expect(verifyWebhookSignature(SECRET, `t=${T},v1=${VECTOR}`, BODY, T + 299)).toBe(true);
    expect(verifyWebhookSignature(SECRET, `t=${T},v1=${VECTOR}`, BODY, T + 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, `t=${T},v1=${VECTOR}`, BODY, T - 301)).toBe(false);
  });
});

import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { BOT_WEBHOOK_SIGNATURE_TOLERANCE_S } from './wire';

/**
 * Webhook signature verification — **the same computation the server performs** when it signs.
 *
 * The key is derived with HKDF from the sha256 of the token's secret part. The server stores only
 * that hash and never the secret itself, so the hash is the one value both sides can arrive at.
 *
 * A request that fails verification is **discarded without being read.** A webhook address is a
 * public HTTPS endpoint that anyone can POST to; without the check, a stranger's "message" would
 * walk straight into the bot's handlers.
 */

export function webhookSigningKey(tokenSecret: string): Buffer {
  const tokenHash = createHash('sha256').update(tokenSecret).digest('hex');
  return Buffer.from(hkdfSync('sha256', Buffer.from(tokenHash, 'hex'), Buffer.alloc(0), 'graygate:bot-webhook-v1', 32));
}

/**
 * True when the header reads `t=<unix seconds>,v1=<hex>` and the HMAC matches this body. A
 * timestamp outside the tolerance is treated as a replay.
 */
export function verifyWebhookSignature(
  tokenSecret: string,
  header: string | undefined,
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((piece) => {
      const [k, v] = piece.split('=');
      return [k?.trim() ?? '', v?.trim() ?? ''];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowS - t) > BOT_WEBHOOK_SIGNATURE_TOLERANCE_S) return false;

  const expected = createHmac('sha256', webhookSigningKey(tokenSecret)).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The secret part of a `gg1.<botId>.<secret>` token — the material the signing key comes from. */
export function tokenSecret(token: string): string {
  const parts = token.split('.');
  return parts.length === 3 ? parts[2]! : '';
}

/**
 * Generated from protocol/src/rest.ts in the graygate monorepo — do not edit by hand.
 * Only the declarations the bot SDK needs are here; the rest of that module stays private.
 */

import { BOT_WEBHOOK_BATCH_MAX } from './constants';
import { envelopeNewPayload, msgNewPayload } from './events';
import { z } from 'zod';

const uuid = z.string().uuid();

/**
 * The webhook body a bot receives. Each item has **the same shape** as the payload the WebSocket
 * pushes to a phone.
 *
 * What leaves is ciphertext, so a webhook delivered to the wrong address leaks the metadata around
 * a message — room id, sender id, timestamp — and not what was said.
 */
export const botWebhookItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('msg.new'), payload: msgNewPayload }),
  z.object({ type: z.literal('envelope.new'), payload: envelopeNewPayload }),
  z.object({ type: z.literal('member.joined'), payload: z.object({ roomId: uuid, userId: uuid }) }),
  z.object({ type: z.literal('member.left'), payload: z.object({ roomId: uuid, userId: uuid }) }),
  z.object({
    type: z.literal('member.key_changed'),
    payload: z.object({ roomId: uuid, userId: uuid, keyUpdatedAt: z.string().datetime() }),
  }),
  z.object({ type: z.literal('room.deleted'), payload: z.object({ roomId: uuid }) }),
]);

export type BotWebhookItem = z.infer<typeof botWebhookItem>;

export const botWebhookBody = z.object({
  botId: uuid,
  items: z.array(botWebhookItem).max(BOT_WEBHOOK_BATCH_MAX),
});

export type BotWebhookBody = z.infer<typeof botWebhookBody>;

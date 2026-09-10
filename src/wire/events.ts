/**
 * Generated from protocol/src/ws.ts in the graygate monorepo — do not edit by hand.
 * Only the declarations the bot SDK needs are here; the rest of that module stays private.
 */

import { encryptedPayloadSchema } from './body';
import { z } from 'zod';

const uuid = z.string().uuid();

export const msgNewPayload = z.object({
  id: uuid,
  roomId: uuid,
  senderId: uuid,
  keyVersion: z.number().int().positive(),
  kind: z.enum(['text', 'media']),
  ciphertext: encryptedPayloadSchema,
  mediaId: uuid.optional(),
  createdAt: z.string().datetime(),
});

export const envelopeNewPayload = z.object({
  id: uuid,
  roomId: uuid,
  keyVersion: z.number().int().positive(),
  purpose: z.enum(['invite', 'rotation']),
  ciphertext: z.string().min(1), // RSA-OAEP base64
  createdBy: uuid,
});

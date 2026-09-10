/**
 * Generated from protocol/src/body.ts in the graygate monorepo — do not edit by hand.
 * Only the declarations the bot SDK needs are here; the rest of that module stays private.
 */

import { MEDIA_MAX_BYTES, TEXT_CIPHERTEXT_MAX } from './constants';
import { z } from 'zod';

/**
 * Channel post or comment — **no `parentId` means a post, a `parentId` means a first-level comment
 * on that post.**
 *
 * The parent reference sits inside the ciphertext so the server never learns the shape of a
 * conversation. The price is that the server cannot enforce who may post; that is enforced twice on
 * the client instead, once by hiding the composer and once by checking on receipt.
 *
 * Outside a channel the field is ignored — out of spec, absorbed harmlessly. Replies to replies do
 * not exist: if the parent is already a comment, the receiving client refuses it.
 */
const parentId = z.string().uuid().optional();

/**
 * The message being replied to — **the id alone, never a copy of what it said.**
 *
 * Leaving out the quoted snapshot is the whole design of the feature:
 *
 * 1. A device without the original **has no business learning it.** Someone who joined late, whose
 *    copy expired under auto-delete, or who deleted it locally only needs to know "this is a
 *    reply". They had no path to the original in the first place.
 * 2. A snapshot would be **a copy that outlives both auto-delete and local deletion**: a sentence
 *    that should have expired lives on inside somebody else's reply, out of reach of the deletion
 *    that was supposed to remove it.
 *
 * So the quote card is drawn **only when the receiving device finds the original in its own
 * storage.** Otherwise the message just shows as a reply. It is a separate field from `parentId`
 * because it means something else: `parentId` is the post/comment hierarchy of a channel, this is a
 * reference between messages at the same level.
 *
 * A client too old to know this field has it stripped by the schema and renders the text alone.
 */
const replyTo = z.string().uuid().optional();

export const messageBodySchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('text'),
    text: z.string().min(1).max(8000),
    parentId,
    replyTo,
  }),
  z.object({
    t: z.literal('media'),
    fileName: z.string().min(1).max(255),
    mime: z.string().min(1).max(100),
    size: z.number().int().positive().max(MEDIA_MAX_BYTES),
    /**
     * Text sent along with the attachment, up to the same 8,000 characters as a text message.
     *
     * It rides in the same message rather than a second one because in a channel one message is one
     * post: split them and a picture and its caption become **two separate posts** (and the caption
     * cannot be a comment either — the parent id only exists once the first one is stored).
     *
     * Nothing changes for the server; this is inside the ciphertext. A client too old to know the
     * field has it stripped by the schema and renders the attachment alone.
     */
    caption: z.string().min(1).max(8000).optional(),
    /**
     * Ties together several pictures chosen at once. Messages sharing a `groupId` are drawn as one
     * bubble, and tapping opens them in a swipeable viewer — but each picture is still **its own
     * message**, with its own key, upload and acknowledgement. The server sees none of this. A
     * client too old to know the field has it stripped and draws the pictures one by one, which
     * loses the grouping and nothing else. `groupCount` is how many the sender sent, so the
     * receiver can tell that some have not arrived yet.
     */
    groupId: z.string().uuid().optional(),
    groupCount: z.number().int().min(2).max(50).optional(),
    parentId,
    replyTo,
  }),
  /**
   * A shared location: **two numbers and nothing else.** No map image, no street address, no place
   * name — a map tile is an outbound request, and an address or place name means handing the
   * coordinates to a geocoding service first.
   *
   * The receiver draws a card from these numbers and only opens the system map app after the person
   * confirms, building the URL itself from the validated numbers. A string supplied by the sender
   * is never opened.
   *
   * `accuracy` is the radius in metres, when known. A client too old to know this type fails the
   * discriminated union and leaves an "integrity check failed" line, which is better than
   * disguising the message as text — that would put coordinates in a body where they render as a
   * tappable link.
   */
  z.object({
    t: z.literal('location'),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(100_000).optional(),
    parentId,
    replyTo,
  }),
  // System events sent by clients — this path is for things the server must not learn.
  z.object({
    t: z.literal('sys.screenshot'),
  }),
  /**
   * Pins a channel post. With a `messageId` the post is pinned; **without one the pin is cleared.**
   *
   * The pin is not server state for the same reason posting rights are not: the server cannot tell
   * which ciphertext is a post, so it could not act on "pin that one" without being told, in the
   * clear, which message belongs to which room. So a pin travels exactly like a post — one message
   * encrypted with the room key — and every device records it locally.
   *
   * Authority works the same way. The control is shown only to the admin, and a receiving client
   * applies the pin only when the sender created the room. Outside a channel it is ignored.
   *
   * **A channel has one pin.** Pinning again replaces it, ordered by the message's `createdAt` so
   * that an old event arriving late cannot overwrite a newer pin.
   *
   * A client too old to know this type fails the discriminated union and leaves an "integrity check
   * failed" line.
   */
  z.object({
    t: z.literal('sys.pin'),
    messageId: z.string().uuid().optional(),
  }),
]);

export type MessageBody = z.infer<typeof messageBodySchema>;

/**
 * How an encrypted message travels — the same shape the crypto layer produces. The size limits here
 * are the ones the server enforces.
 */
export const encryptedPayloadSchema = z.object({
  ciphertext: z.string().min(1).max(TEXT_CIPHERTEXT_MAX),
  iv: z.string().min(1).max(64), // 16-byte AES-CBC IV, base64 = 24 chars
  mac: z.string().min(1).max(128), // HMAC-SHA256 in hex = 64 chars
});

export type EncryptedPayload = z.infer<typeof encryptedPayloadSchema>;

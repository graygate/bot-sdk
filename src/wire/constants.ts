/**
 * Generated from protocol/src/constants.ts in the graygate monorepo — do not edit by hand.
 * Only the declarations the bot SDK needs are here; the rest of that module stays private.
 */

/** Largest ciphertext a text message may carry (bytes, after base64 encoding). */
export const TEXT_CIPHERTEXT_MAX = 64 * 1024;

/** Largest media file (bytes). Uploaded straight to object storage, never through the server. */
export const MEDIA_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Longest comment on a channel post (a post itself may run to 8,000 characters — see body.ts).
 * **Only the sending client enforces this**: the limit lives inside the ciphertext, where the
 * server cannot see it.
 */
export const COMMENT_TEXT_MAX = 2000;

/**
 * The client header (`x-graygate-client`) a bot runtime sends — **not a secret.**
 *
 * The edge in front of the server keeps out traffic that never came from a graygate client at all;
 * it is not a security boundary, so bots get their own value alongside the app's and both are
 * accepted. The edge worker and the server hold copies of both.
 */
export const BOT_CLIENT_TOKEN = 'Qb7dK2mXhs1TfLpA9wEzR4vNc0uGyJ6i';

/** Bot access-token lifetime (minutes), same as a person's. No refresh token: the bot token is the long-lived credential. */
export const BOT_ACCESS_TOKEN_TTL_MIN = 15;

/** Most items one webhook request may carry. */
export const BOT_WEBHOOK_BATCH_MAX = 100;

/** How far a signature timestamp may be from now (seconds). Anything further is treated as a replay and dropped. */
export const BOT_WEBHOOK_SIGNATURE_TOLERANCE_S = 300;

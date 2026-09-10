/**
 * Generated from crypto/src/index.ts in the graygate monorepo — do not edit by hand.
 * Only the declarations the bot SDK needs are here; the rest of that module stays private.
 */

import CryptoJS from 'crypto-js';
import forge from 'node-forge';
import { CryptoUtils } from 'graygate-cypher/dist/crypto';

export class IntegrityError extends Error {
  constructor() {
    super('message integrity check failed (HMAC mismatch)');
    this.name = 'IntegrityError';
  }
}

export class DecryptionError extends Error {
  constructor() {
    super('decryption failed');
    this.name = 'DecryptionError';
  }
}

/** Domain separation — one password derives keys that are independent of each other. */
const CTX = {
  roomKey: 'graygate:v1:roomkey',
  verifier: 'graygate:v1:verifier',
  hmac: 'graygate:v1:hmac',
  devicePin: 'graygate:v1:devicepin',
  /** Recovery phrase to the verifier sent to the server. */
  recovery: 'graygate:v1:recovery',
  /** Recovery phrase to the verifier kept on this device. **Must differ** from the server's. */
  recoveryLocal: 'graygate:v1:recoverylocal',
} as const;

export interface EncryptedMessage {
  ciphertext: string;
  iv: string;
  mac: string;
}

export interface RsaKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/**
 * Generates a user's RSA key pair — at signup, and again when someone moves to a new device. It is
 * pure JavaScript, so on a phone it can take tens of seconds.
 *
 * **Why the stepwise generator:** the callback form of `generateKeyPair` holds the JavaScript thread
 * for the whole computation when there is no worker to run it on. The progress line set just before
 * it ("generating keys") never reaches the screen, and the person watches the *previous* step's text
 * sit there for half a minute. Stepping the generator in slices and yielding to the event loop in
 * between keeps the progress honest — a slow security step should be **shown**, not hidden.
 */
export function generateRsaKeyPair(bits = 2048): Promise<RsaKeyPair> {
  // The stepwise API exists at runtime but is missing from the type definitions, hence the cast.
  const rsa = forge.pki.rsa as unknown as {
    createKeyPairGenerationState(bits: number, e: number): { keys: forge.pki.KeyPair | null };
    stepKeyPairGenerationState(state: unknown, ms: number): boolean;
  };

  return new Promise((resolve, reject) => {
    const state = rsa.createKeyPairGenerationState(bits, 0x10001);
    const run = (): void => {
      try {
        // 100ms of work at a time, then yield — enough that frames still get drawn.
        if (!rsa.stepKeyPairGenerationState(state, 100)) {
          setTimeout(run, 0);
          return;
        }
        const keys = state.keys!;
        resolve({
          publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
          privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    run();
  });
}

async function deriveMacKey(roomKey: string): Promise<string> {
  return CryptoUtils.deriveFileKey(roomKey, CTX.hmac);
}

/** Encrypts a message body (any JSON-serialisable value) with the room key and signs it. */
export async function encryptMessage(roomKey: string, body: unknown): Promise<EncryptedMessage> {
  const { encryptedData, iv } = await CryptoUtils.encrypt(JSON.stringify(body), roomKey);
  const macKey = await deriveMacKey(roomKey);
  const mac = CryptoJS.HmacSHA256(`${encryptedData}.${iv}`, macKey).toString(CryptoJS.enc.Hex);
  return { ciphertext: encryptedData, iv, mac };
}

/**
 * Verifies the HMAC, then decrypts. A mismatch throws `IntegrityError` and decryption is never
 * attempted — this is the first stage of the content-validation pipeline, and it runs before any
 * received bytes reach a parser.
 */
export async function decryptMessage(roomKey: string, msg: EncryptedMessage): Promise<unknown> {
  const macKey = await deriveMacKey(roomKey);
  const expected = CryptoJS.HmacSHA256(`${msg.ciphertext}.${msg.iv}`, macKey).toString(CryptoJS.enc.Hex);
  if (!constantTimeEqual(expected, msg.mac)) throw new IntegrityError();

  let plain: string;
  try {
    plain = await CryptoUtils.decrypt(msg.ciphertext, roomKey, msg.iv);
  } catch {
    throw new DecryptionError();
  }
  if (!plain) throw new DecryptionError();
  try {
    return JSON.parse(plain);
  } catch {
    throw new DecryptionError();
  }
}

/** Opens an envelope with this device's private key (PEM) and returns the room key. */
export function unwrapRoomKey(wrapped: string, privateKeyPem: string): Promise<string> {
  return CryptoUtils.decryptFileKey(wrapped, new TextEncoder().encode(privateKeyPem));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

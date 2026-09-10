import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  COMMENT_TEXT_MAX,
  botWebhookBody,
  messageBodySchema,
  type BotWebhookItem,
  type MessageBody,
} from './wire';
import {
  decryptMessage,
  encryptMessage,
  generateRsaKeyPair,
  unwrapRoomKey,
  type EncryptedMessage,
} from './wire';
import { BotApi, BotApiError } from './api';
import { BotState } from './state';
import { tokenSecret, verifyWebhookSignature } from './signature';

export { BotApiError } from './api';
export { verifyWebhookSignature, webhookSigningKey } from './signature';

/**
 * The graygate bot runtime.
 *
 * Four things happen here: it authenticates with the bot token and, on a first run, generates a key
 * pair and activates the account; it receives webhooks, **verifies the signature before anything
 * else**, and consumes envelopes to learn room keys; it decrypts messages and hands them to your
 * handlers; and it encrypts replies and posts them back.
 *
 * Every cryptographic operation goes through the wire module — no hand-rolled crypto here.
 *
 * **Media handed to a handler is unverified.** This runtime is not a renderer, and what you do with
 * those bytes is yours to decide: do not pass them straight to an image decoder or a file path.
 */

export interface BotOptions {
  /** `gg1.<botId>.<secret>`. Read it from the environment; never write it to a file. */
  token: string;
  /** Server origin. Bots do not use the app's fallback-domain logic — you choose the address. */
  origin?: string;
  /** Where the private key, the room keys and the handled ids live. **Back this up.** */
  stateDir: string;
  webhook: {
    port: number;
    /** Defaults to `/hook`. */
    path?: string;
    /** The public https address to register. Private and loopback addresses are refused. */
    publicUrl: string;
    /** Bind to one interface only — `127.0.0.1` when a reverse proxy sits in front. */
    host?: string;
  };
  /** Defaults to true; set false to decide inside `bot.on('invite')`. */
  autoAcceptInvites?: boolean;
}

export interface MessageContext {
  roomId: string;
  messageId: string;
  senderId: string;
  body: MessageBody;
  /** The text, when `body.t === 'text'`. */
  text: string | null;
  reply(text: string): Promise<void>;
}

export interface JoinContext {
  roomId: string;
  userId: string;
  reply(text: string): Promise<void>;
}

export interface InviteContext {
  inviteId: string;
  roomId: string;
  accept(): Promise<void>;
  decline(): Promise<void>;
}

export interface CommandContext extends MessageContext {
  command: string;
  args: string;
}

type MessageHandler = (ctx: MessageContext) => void | Promise<void>;
type JoinHandler = (ctx: JoinContext) => void | Promise<void>;
type InviteHandler = (ctx: InviteContext) => void | Promise<void>;
type CommandHandler = (ctx: CommandContext) => void | Promise<void>;

export class Bot {
  private readonly api: BotApi;
  private readonly state: BotState;
  private readonly secret: string;
  private readonly path: string;
  private server: Server | null = null;
  private username = '';

  private messageHandlers: MessageHandler[] = [];
  private joinHandlers: JoinHandler[] = [];
  private inviteHandlers: InviteHandler[] = [];
  private commandHandlers = new Map<string, CommandHandler>();

  constructor(private readonly options: BotOptions) {
    this.api = new BotApi(options.origin ?? 'https://server.graygate.app', options.token);
    this.state = new BotState(options.stateDir);
    this.secret = tokenSecret(options.token);
    this.path = options.webhook.path ?? '/hook';
  }

  on(event: 'message', handler: MessageHandler): void;
  on(event: 'join', handler: JoinHandler): void;
  on(event: 'invite', handler: InviteHandler): void;
  on(event: 'message' | 'join' | 'invite', handler: MessageHandler | JoinHandler | InviteHandler): void {
    if (event === 'message') this.messageHandlers.push(handler as MessageHandler);
    else if (event === 'join') this.joinHandlers.push(handler as JoinHandler);
    else this.inviteHandlers.push(handler as InviteHandler);
  }

  /** A command such as `/start`. Names are ASCII lowercase, digits and underscores. */
  command(name: string, handler: CommandHandler): void {
    this.commandHandlers.set(name, handler);
  }

  /**
   * Starts the bot: activates it (generating a key pair on a first run), serves the webhook, and
   * registers it. **Registering is also the request for a backfill** — there is no polling, so this
   * is when everything that piled up while the bot was down comes in.
   */
  async start(): Promise<void> {
    await this.ensureActivated();
    await this.listen();
    await this.api.call('PUT', '/bot/webhook', { url: this.options.webhook.publicUrl });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async ensureActivated(): Promise<void> {
    const me = await this.api.call('POST', '/bot/auth', undefined).catch(() => null);
    void me; // The client handles authentication; all this decides is whether we are active.
    const profile = await this.api.call('GET', '/bot/me');
    this.username = String(profile.username ?? '');
    if (profile.active === true) {
      if (!this.state.readPrivateKey()) {
        throw new Error(
          'This bot is active but the state directory has no private key, so its old room keys are ' +
            'gone. Replace the key with PUT /bot/public-key and ask each room admin to invite it again.',
        );
      }
      return;
    }
    const pair = await generateRsaKeyPair();
    this.state.writePrivateKey(pair.privateKeyPem);
    await this.api.call('POST', '/bot/activate', { rsaPublicKey: pair.publicKeyPem });
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res).catch(() => {
          // A throwing handler answers non-2xx, and the server sends the batch again.
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.on('error', reject);
      server.listen(this.options.webhook.port, this.options.webhook.host, () => {
        this.server = server;
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== this.path) {
      res.writeHead(404);
      res.end();
      return;
    }
    const raw = await readBody(req);
    const signature = req.headers['x-graygate-signature'];
    if (!verifyWebhookSignature(this.secret, Array.isArray(signature) ? signature[0] : signature, raw)) {
      // A request with a bad signature is not even parsed.
      res.writeHead(401);
      res.end();
      return;
    }

    const parsed = botWebhookBody.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      res.writeHead(400);
      res.end();
      return;
    }

    /**
     * 2xx goes back only once every handler has finished without throwing. A 2xx **is** the
     * acknowledgement: answer it after a failure and the message is dropped from the server's queue
     * for good. Anything else and the server retries after a backoff.
     */
    for (const item of parsed.data.items) await this.handleItem(item);
    res.writeHead(200);
    res.end();
  }

  private async handleItem(item: BotWebhookItem): Promise<void> {
    switch (item.type) {
      case 'envelope.new': {
        const privateKey = this.state.readPrivateKey();
        if (!privateKey) return;
        const roomKey = await unwrapRoomKey(item.payload.ciphertext, privateKey);
        this.state.putRoomKey(item.payload.roomId, item.payload.keyVersion, roomKey);
        if (item.payload.purpose === 'invite') await this.onInvite(item.payload.roomId);
        return;
      }
      case 'msg.new': {
        // At-least-once delivery: the same item can arrive twice.
        if (this.state.markSeen(item.payload.id)) return;
        const roomKey = this.state.roomKey(item.payload.roomId, item.payload.keyVersion);
        // No key, no way to open it. **Acknowledge anyway** — refusing would replay it for 14 days.
        if (!roomKey) return;
        let body: unknown;
        try {
          body = await decryptMessage(roomKey, item.payload.ciphertext as unknown as EncryptedMessage);
        } catch {
          return; // Integrity check failed — dropped quietly, exactly as a phone would.
        }
        const parsed = messageBodySchema.safeParse(body);
        if (!parsed.success) return;
        await this.dispatchMessage(item.payload.roomId, item.payload.id, item.payload.senderId, parsed.data);
        return;
      }
      case 'member.joined': {
        for (const handler of this.joinHandlers) {
          await handler({
            roomId: item.payload.roomId,
            userId: item.payload.userId,
            reply: (text) => this.send(item.payload.roomId, text),
          });
        }
        return;
      }
      case 'room.deleted': {
        this.state.forgetRoom(item.payload.roomId);
        return;
      }
      case 'member.left':
      case 'member.key_changed':
        return;
    }
  }

  private async dispatchMessage(
    roomId: string,
    messageId: string,
    senderId: string,
    body: MessageBody,
  ): Promise<void> {
    const text = body.t === 'text' ? body.text : null;
    const ctx: MessageContext = {
      roomId,
      messageId,
      senderId,
      body,
      text,
      reply: (value) => this.send(roomId, value),
    };

    if (text?.startsWith('/')) {
      const [head, ...rest] = text.slice(1).split(/\s+/);
      // With more than one bot in a room people write `/start@some_bot`; ignore other bots' commands.
      const [name, target] = (head ?? '').split('@');
      if (!target || target === this.username) {
        const handler = this.commandHandlers.get(name ?? '');
        if (handler) {
          await handler({ ...ctx, command: name ?? '', args: rest.join(' ') });
          return;
        }
      }
    }

    for (const handler of this.messageHandlers) await handler(ctx);
  }

  private async onInvite(roomId: string): Promise<void> {
    const invites = (await this.api.callList('GET', '/invites')) as { id: string; roomId: string }[];
    const invite = invites.find((i) => i.roomId === roomId);
    if (!invite) return;
    const ctx: InviteContext = {
      inviteId: invite.id,
      roomId,
      accept: async () => {
        await this.api.call('POST', `/invites/${invite.id}/accept`, {});
      },
      decline: async () => {
        await this.api.call('POST', `/invites/${invite.id}/decline`, {});
      },
    };
    if (this.inviteHandlers.length === 0) {
      if (this.options.autoAcceptInvites !== false) await ctx.accept();
      return;
    }
    for (const handler of this.inviteHandlers) await handler(ctx);
  }

  /** Sends text. Does nothing when there is no room key — not invited yet, or removed. */
  async send(roomId: string, text: string): Promise<void> {
    const key = this.state.latestRoomKey(roomId);
    if (!key) return;
    // The length limit is enforced here before sending, the same place a phone enforces it.
    const trimmed = text.slice(0, 8000);
    const ciphertext = await encryptMessage(key.roomKey, { t: 'text', text: trimmed } satisfies MessageBody);
    try {
      await this.api.call('POST', '/bot/messages', {
        id: randomUUID(),
        roomId,
        keyVersion: key.keyVersion,
        kind: 'text',
        ciphertext,
      });
    } catch (err) {
      // The room key moved on; the next envelope arrives by webhook and the next send works.
      if (err instanceof BotApiError && (err.code === 'stale_key' || err.code === 'not_member')) return;
      throw err;
    }
  }

  /** Comments on a post — channels only; carries the parent post's id. */
  async replyToPost(roomId: string, parentId: string, text: string): Promise<void> {
    const key = this.state.latestRoomKey(roomId);
    if (!key) return;
    const ciphertext = await encryptMessage(key.roomKey, {
      t: 'text',
      text: text.slice(0, COMMENT_TEXT_MAX),
      parentId,
    } satisfies MessageBody);
    await this.api.call('POST', '/bot/messages', {
      id: randomUUID(),
      roomId,
      keyVersion: key.keyVersion,
      kind: 'text',
      ciphertext,
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // A body far past the batch limit did not come from the graygate server.
      if (size > 8 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

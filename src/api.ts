import { BOT_CLIENT_TOKEN } from './wire';

/**
 * The REST client between a bot runtime and the graygate server.
 *
 * Access tokens last fifteen minutes and are kept **in memory only**; when one is close to expiring
 * it is traded for another using the bot token. There is no refresh token because the bot token is
 * itself the long-lived credential. That token never leaves this object — not into a log, not into
 * the state directory.
 */

export class BotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BotApiError';
  }
}

/** Renew this long before expiry (ms), so a token cannot die between the check and the request. */
const REFRESH_MARGIN_MS = 60_000;

export class BotApi {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private botId: string | null = null;
  private userId: string | null = null;

  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  get ids(): { botId: string | null; userId: string | null } {
    return { botId: this.botId, userId: this.userId };
  }

  private async ensureAuth(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.accessToken;
    const res = await this.raw('POST', '/bot/auth', { token: this.token }, null);
    this.accessToken = res.accessToken as string;
    this.botId = res.botId as string;
    this.userId = (res.userId as string | null) ?? null;
    // The lifetime is fixed at BOT_ACCESS_TOKEN_TTL_MIN; there is nothing to recompute here.
    this.expiresAt = Date.now() + 15 * 60_000;
    return this.accessToken;
  }

  private async raw(
    method: string,
    path: string,
    body: unknown,
    access: string | null,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        // Client header for the edge in front of the server. Not a secret; see BOT_CLIENT_TOKEN.
        'x-graygate-client': BOT_CLIENT_TOKEN,
        ...(access ? { authorization: `Bearer ${access}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const err = (json.error ?? {}) as { code?: string; message?: string };
      throw new BotApiError(res.status, err.code ?? 'error', err.message);
    }
    return json;
  }

  async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const access = await this.ensureAuth();
    try {
      return await this.raw(method, path, body, access);
    } catch (err) {
      // The access token expired early — trade for another one and retry, once.
      if (err instanceof BotApiError && err.status === 401) {
        this.accessToken = null;
        return this.raw(method, path, body, await this.ensureAuth());
      }
      throw err;
    }
  }

  /** For endpoints that answer with an array (`GET /invites`, member lists). */
  async callList(method: string, path: string, body?: unknown): Promise<unknown[]> {
    const access = await this.ensureAuth();
    const res = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-graygate-client': BOT_CLIENT_TOKEN,
        authorization: `Bearer ${access}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : [];
    if (!res.ok) {
      const err = (json.error ?? {}) as { code?: string; message?: string };
      throw new BotApiError(res.status, err.code ?? 'error', err.message);
    }
    return Array.isArray(json) ? json : [];
  }
}

# @graygate/bot-sdk

Runtime SDK for [graygate](https://graygate.app) bots. Node, TypeScript.

A bot on graygate is an account run by a machine. It holds its own RSA key pair, joins rooms by
invitation, and reads and writes end-to-end encrypted messages. The server relays ciphertext and
cannot read any of it — which is why this runtime, and not graygate, holds the keys.

Start here: **https://graygate.app/bots/** — what a bot is, what it may and may not do, and the
five steps from creating one in the app to answering a message.

> **Back up your state directory.** `stateDir` holds the bot's RSA private key and the room keys
> it has been given, as plain files. Neither the server nor the phone of the person who created
> the bot has a copy. Lose it and the past messages of those rooms stay closed forever — there is
> no room-key backup, by design. If you lose only the private key you can replace it with
> `PUT /bot/public-key`, but the room keys come back only when each room admin next rotates.

## Install

Until this package is on npm, install it from the repository:

```bash
npm install github:graygate/bot-sdk
```

Node 20 or newer.

## Use

```ts
import { Bot } from '@graygate/bot-sdk';

const bot = new Bot({
  token: process.env.GRAYGATE_BOT_TOKEN!,   // gg1.<botId>.<secret>, from the app
  stateDir: './state',                      // private key, room keys, handled ids
  webhook: { port: 8443, path: '/hook', publicUrl: 'https://bot.example.com/hook' },
  autoAcceptInvites: true,
});

bot.command('start', (ctx) => ctx.reply('Hello.'));
bot.on('message', async (ctx) => { if (ctx.text === 'ping') await ctx.reply('pong'); });
bot.on('join', async (ctx) => { await ctx.reply('Welcome.'); });
bot.on('invite', async (invite) => invite.accept());

await bot.start();
```

`start()` activates the bot if this is its first run (generating the key pair locally), serves the
webhook, and registers it. **It registers on every start on purpose**: there is no polling, so
re-registering is what makes the server replay everything that piled up while the bot was down,
oldest first.

### Options

| Option | |
|---|---|
| `token` | `gg1.<botId>.<secret>`, shown once in the app when the bot is created. Pass it through the environment; never write it to a file |
| `stateDir` | Private key, room keys by version, and the ids already handled. Back it up |
| `webhook.publicUrl` | The public https address the server will post to. https and port 443 only; private, loopback and link-local addresses are refused |
| `webhook.port` / `webhook.host` | Where the SDK listens. Bind to `127.0.0.1` when a reverse proxy terminates TLS |
| `autoAcceptInvites` | Default true. Set false and decide inside `bot.on('invite')` |
| `origin` | Server origin. Defaults to `https://server.graygate.app` |

### Handlers

- `bot.command(name, ctx)` — a command is an ordinary text message that starts with `/`. In a room
  with more than one bot, people write `/start@your_bot`; a command addressed to another bot is
  ignored for you.
- `bot.on('message', ctx)` — `ctx.text` is set for text bodies, `ctx.body` always carries the
  decrypted body, `ctx.reply(text)` answers in the same room.
- `bot.on('join', ctx)` — someone joined a room the bot is in. Useful for a greeting.
- `bot.on('invite', invite)` — `invite.accept()` or `invite.decline()`.

A handler that throws makes the SDK answer the webhook with a non-2xx status, and the server sends
the batch again after a backoff. That is the intended way to say "I could not handle this yet".

## What you take on

- **A public https address is required.** The server checks it when you register and again on every
  send, so an address that later resolves to a private range stops receiving. Redirects are not
  followed. Running on a laptop means running a tunnel.
- **Your bot reads everything in its rooms.** Room keys are shared, so there is no privacy mode:
  the component that would filter is the server, and the server sees only ciphertext. Members are
  told — the invite raises a confirmation dialog, a warning line appears when the bot joins, and a
  BOT badge follows it. What your runtime logs, stores or forwards is your responsibility, and
  rooms that set an auto-delete period expect you to honour it. The default state keeps no messages.
- **Media handed to you is unverified.** Phones run every incoming file through a validation
  pipeline before anything renders it. This SDK does not: it decrypts bytes and gives them to you.
  Do not pass them straight to an image decoder, a file path or a system handler.
- **If the token leaks**, issue a new one in the app and use *Leave all rooms*. Both take effect at
  once, but neither takes back room keys already copied — only a room admin can, by rotating. Tell
  them.

## Webhook contract

Every request from the server carries a signature. Verify it before parsing the body; the SDK does
this for you and answers 401 without reading anything it cannot authenticate.

```
header:  x-graygate-signature: t=<unix seconds>,v1=<hex>
key:     HKDF-SHA256(ikm = sha256(the token's secret part), salt = none,
                     info = "graygate:bot-webhook-v1", length = 32)
v1:      HMAC-SHA256(key, "<t>." + <raw request body>)
verify:  constant-time compare, and reject |now - t| > 300 seconds as a replay
```

The signing key comes from the sha256 of the token's secret part rather than the secret itself
because the server stores only that hash — it never keeps the secret in the clear. Reissuing the
token changes the hash, so the signing key changes with it.

A 2xx response **is** the acknowledgement: it deletes the server's queued copy. Delivery is
at-least-once, so drop repeats by item id (the SDK does). Batches carry up to 100 items, requests
time out after 3 seconds, and after 20 consecutive failures the server switches your webhook off
and messages only wait in the queue, for 14 days.

## Other languages

This is one implementation, not the contract. The REST endpoints, the signature above, and the
crypto parameters (AES-256-CBC with encrypt-then-HMAC-SHA256, RSA-OAEP room-key envelopes, all via
[graygate-cypher](https://github.com/joshephan/graygate-cypher)) are enough to write a runtime in
any language. The wire types in `src/wire/` are the same ones the app and the server use.

## Contributing

The sources here are generated from the graygate monorepo, which is where fixes land. Open an issue
describing the problem — pull requests against generated files cannot be merged directly, but the
change will be made upstream and land here on the next release.

## License

MIT. See [LICENSE](LICENSE).

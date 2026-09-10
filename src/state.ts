import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bot runtime's state directory.
 *
 * It holds **the private key PEM and the room keys, in the clear**. Neither the server nor the
 * phone of the person who created the bot has a copy, so this directory is the only one: lose it
 * and the past messages of those rooms never open again (there is no room-key backup, by design),
 * and new messages stay closed until the next rotation. **Guarding and backing it up is the
 * operator's job.**
 *
 * The bot token is not written here. It arrives through the environment and stays in memory.
 */

interface StateShape {
  /** room id → key version → room key */
  roomKeys: Record<string, Record<string, string>>;
  /** Ids already handled. Delivery is at-least-once, so the same item can arrive twice. */
  seen: string[];
}

const SEEN_MAX = 5000;

export class BotState {
  private readonly keyPath: string;
  private readonly statePath: string;
  private state: StateShape = { roomKeys: {}, seen: [] };
  private seenSet = new Set<string>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.keyPath = join(dir, 'private-key.pem');
    this.statePath = join(dir, 'state.json');
    try {
      this.state = JSON.parse(readFileSync(this.statePath, 'utf8')) as StateShape;
      this.state.roomKeys ??= {};
      this.state.seen ??= [];
      this.seenSet = new Set(this.state.seen);
    } catch {
      // First run — start empty.
    }
  }

  readPrivateKey(): string | null {
    try {
      return readFileSync(this.keyPath, 'utf8');
    } catch {
      return null;
    }
  }

  writePrivateKey(pem: string): void {
    writeAtomic(this.keyPath, pem);
  }

  roomKey(roomId: string, keyVersion: number): string | null {
    return this.state.roomKeys[roomId]?.[String(keyVersion)] ?? null;
  }

  /** The newest key version and its key — what sending uses. */
  latestRoomKey(roomId: string): { keyVersion: number; roomKey: string } | null {
    const versions = this.state.roomKeys[roomId];
    if (!versions) return null;
    let best = 0;
    for (const v of Object.keys(versions)) best = Math.max(best, Number(v));
    const roomKey = versions[String(best)];
    return best > 0 && roomKey ? { keyVersion: best, roomKey } : null;
  }

  putRoomKey(roomId: string, keyVersion: number, roomKey: string): void {
    (this.state.roomKeys[roomId] ??= {})[String(keyVersion)] = roomKey;
    this.persist();
  }

  forgetRoom(roomId: string): void {
    delete this.state.roomKeys[roomId];
    this.persist();
  }

  /** Whether this item was already handled; a first sighting is recorded and returns false. */
  markSeen(id: string): boolean {
    if (this.seenSet.has(id)) return true;
    this.seenSet.add(id);
    this.state.seen.push(id);
    if (this.state.seen.length > SEEN_MAX) {
      const dropped = this.state.seen.splice(0, this.state.seen.length - SEEN_MAX);
      for (const old of dropped) this.seenSet.delete(old);
    }
    this.persist();
    return false;
  }

  private persist(): void {
    writeAtomic(this.statePath, JSON.stringify(this.state));
  }
}

/** Write to a temporary file, then rename — dying mid-write cannot leave half a state file. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

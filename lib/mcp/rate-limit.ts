import IORedis from "ioredis";

// Per user + client MCP quota: a fixed one-minute window counted in Valkey
// (`INCRBY` + `EXPIRE` in one MULTI), so every app instance shares it. The
// limit protects the instance from a runaway agent; it is not an
// availability gate, so a Valkey that cannot answer lets the call through
// and says so once per outage.

export type McpCallKind = "read" | "write";

const LIMITS: Record<McpCallKind, number> = { read: 120, write: 20 };
const WINDOW_SECONDS = 60;
// Twice the window, so a key outlives its minute whatever the clock skew
// between instances.
const KEY_TTL_SECONDS = 120;
// A down Valkey must not hold an MCP call: commands give up after this.
const COMMAND_TIMEOUT_MS = 500;

/** The part of an ioredis client the limiter uses. */
type Multi = {
  incrby(key: string, increment: number): Multi;
  expire(key: string, seconds: number): Multi;
  exec(): Promise<[Error | null, unknown][] | null>;
};
export type RateLimitConnection = { multi(): Multi };

let connection: RateLimitConnection | undefined;
let outageLogged = false;

/**
 * Its own connection, not lib/queue's: BullMQ's needs
 * `maxRetriesPerRequest: null` (wait forever), which would hang every MCP
 * call while Valkey is down.
 */
function connectionOf(): RateLimitConnection {
  if (connection) return connection;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  const client = new IORedis(url, {
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
  });
  // Connection errors also reject the pending commands, which is where they
  // are reported; without a listener ioredis prints every reconnect attempt.
  client.on("error", () => {});
  connection = client as unknown as RateLimitConnection;
  return connection;
}

/** Test hook: use `fake` as the Valkey connection; `undefined` resets. */
export function setRateLimitConnectionForTests(
  fake: RateLimitConnection | undefined
): void {
  connection = fake;
  outageLogged = false;
}

async function increment(key: string, units: number): Promise<number> {
  const results = await connectionOf()
    .multi()
    .incrby(key, units)
    .expire(key, KEY_TTL_SECONDS)
    .exec();
  const [error, count] = results?.[0] ?? [new Error("MULTI aborted"), null];
  if (error) throw error;
  if (typeof count !== "number") throw new Error("INCR returned no count");
  return count;
}

/**
 * Counts `units` MCP calls of `kind` (one, or each write call of a legacy
 * batch) for (user, client) in the current minute; over the limit it answers
 * how long until the window turns.
 */
export async function consumeMcpQuota(
  userId: string,
  clientId: string,
  kind: McpCallKind,
  units = 1
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const epochMinute = Math.floor(nowSeconds / WINDOW_SECONDS);
  const key = `mcp:rl:${kind}:${userId}:${clientId}:${epochMinute}`;
  let count: number;
  try {
    count = await increment(key, units);
    outageLogged = false;
  } catch (error) {
    if (!outageLogged) {
      outageLogged = true;
      console.error(
        "[mcp] rate limit unavailable, allowing calls:",
        error instanceof Error ? error.message : error
      );
    }
    return { ok: true };
  }
  if (count <= LIMITS[kind]) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: WINDOW_SECONDS - (nowSeconds % WINDOW_SECONDS),
  };
}

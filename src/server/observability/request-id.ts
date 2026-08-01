import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * One short string that ties together what a resident saw, what the log
 * recorded, and what the error reporter captured.
 *
 * Without it, "it broke when I tapped accept" and a 500 in a log file are two
 * facts that cannot be joined, and the operator's only option is to guess from
 * timestamps. The whole point of this codebase's error handling — a safe
 * generic message to the client, the real detail to the logs — depends on
 * there being a thread between the two halves. This is the thread.
 *
 * **Six characters, not a UUID.** It is read aloud, typed into a message, or
 * copied off a screenshot by somebody who is tired. Thirty-six characters of
 * hyphenated hex is not that. Six hex characters is sixteen million values,
 * which is plenty to disambiguate within the window anybody would search.
 *
 * Upper case in the alphabet is avoided for the same reason: `l`/`I`/`1` and
 * `O`/`0` confusions are read errors, and a read error here sends somebody
 * looking for a request that never existed.
 */

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function newRequestId(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

const storage = new AsyncLocalStorage<string>();

/** Runs `work` with `id` as the ambient request id. */
export function withRequestId<T>(id: string, work: () => T): T {
  return storage.run(id, work);
}

/**
 * The current request's id, or `null` outside a request.
 *
 * `null` rather than a freshly generated one: an id that appears in a log line
 * and nowhere else is worse than no id, because it looks like something you
 * could search for.
 */
export function currentRequestId(): string | null {
  return storage.getStore() ?? null;
}

/** The header the id travels in, request and response. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Honours an inbound id when there is one.
 *
 * A load balancer or the native client may already have stamped the request,
 * and generating a second id would split one event into two. Bounded and
 * filtered because it is attacker-controlled input that ends up in log lines:
 * an unbounded value is a way to write megabytes into somebody's log storage,
 * and a newline is a way to forge a log entry.
 */
export function requestIdFrom(headers: Headers): string {
  const supplied = headers.get(REQUEST_ID_HEADER);
  if (supplied && /^[A-Za-z0-9_-]{4,64}$/.test(supplied)) return supplied;
  return newRequestId();
}

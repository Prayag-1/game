/**
 * A sliding-window limit per key: at most `limit` events in any `windowMs`.
 * In memory, so per process; a multi-process deployment needs it in Redis.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #events = new Map<string, number[]>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Records one event for `key` if it is under the limit. Returns whether it was. */
  take(key: string): boolean {
    const now = this.#now();
    const recent = (this.#events.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#events.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#events.set(key, recent);
    if (this.#events.size > 10_000) this.#prune(now);
    return true;
  }

  #prune(now: number): void {
    for (const [key, times] of this.#events) {
      if (times.every((t) => now - t >= this.#windowMs)) this.#events.delete(key);
    }
  }
}

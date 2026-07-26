/**
 * A tiny in-memory sliding-window rate limiter, keyed by client IP (ADR 0078). Dependency-free and
 * state-only-in-memory — it is the SERVER backstop to the client-side dedupe (step 3), guarding the
 * public /api/client-error endpoint against a flood. No persistence: a restart forgives everyone, which
 * is fine for a log-only endpoint.
 */
export const CLIENT_ERROR_LIMITER = 'CLIENT_ERROR_LIMITER';

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record a hit for `key` at `now` and return whether it is within the window's limit. */
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent); // keep the pruned window; do not record the rejected hit
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Forget all history — used by tests to isolate cases. */
  reset(): void {
    this.hits.clear();
  }
}

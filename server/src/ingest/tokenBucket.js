// Classic token bucket. take(n) returns 0 when allowed, otherwise the number
// of milliseconds until n tokens will be available.
export class TokenBucket {
  constructor(capacity, refillPerSec, now = Date.now()) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
    this.tokens = capacity;
    this.last = now;
  }

  take(n = 1, now = Date.now()) {
    const elapsed = now - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.last = now;
    }
    if (this.tokens >= n) {
      this.tokens -= n;
      return 0;
    }
    return Math.ceil((n - this.tokens) / this.refillPerMs);
  }
}

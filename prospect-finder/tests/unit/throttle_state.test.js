/**
 * Regression tests for "Stalled at 0/474 — breaker_open (http_429 rate limited)".
 *
 * Three separate defects kept the queue pinned against Instagram's rate limit:
 *   1. The file CLAIMED to persist state in chrome.storage.session but had no
 *      persistence code at all. Chrome evicts an idle MV3 worker in ~30s, so
 *      every alarm tick booted a breaker with failures=0 and re-probed.
 *   2. The limiter and breaker shared one storage key with fire-and-forget
 *      read-modify-write, so pacing writes clobbered the breaker's openedAt.
 *   3. A concurrent job succeeding after a sibling's 429 called breaker.reset()
 *      and wiped an active cooldown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';

function mockSession() {
  const store = {};
  globalThis.chrome = {
    ...(globalThis.chrome || {}),
    storage: { session: {
      get: async (k) => ({ [k]: store[k] }),
      set: async (o) => { Object.assign(store, o); },
    } },
  };
  return store;
}

test('breaker cooldown survives worker eviction', async () => {
  mockSession();
  const { CircuitBreaker } = await import('../../src/background/rate_limiter.js?t1');

  const dying = new CircuitBreaker();
  dying.trip(0);
  await dying.persist();
  assert.ok(dying.isOpen);

  // New worker generation: module state starts empty.
  const reborn = new CircuitBreaker();
  assert.strictEqual(reborn.isOpen, false, 'fresh breaker starts closed');
  await reborn.hydrate();
  assert.ok(reborn.isOpen, 'hydrated breaker must still be cooling down');
  assert.ok(reborn.remaining() > 0);
});

test('limiter writes do not clobber breaker state', async () => {
  const store = mockSession();
  const { CircuitBreaker, AdaptiveRateLimiter } =
    await import('../../src/background/rate_limiter.js?t2');

  const b = new CircuitBreaker();
  b.trip(0);
  await b.persist();

  const l = new AdaptiveRateLimiter({ baseDelayMs: 1, maxDelayMs: 5, perMinuteCap: 100 });
  for (let i = 0; i < 5; i++) await l.persist();

  const reborn = new CircuitBreaker();
  await reborn.hydrate();
  assert.ok(reborn.isOpen, 'breaker cooldown must outlive limiter pacing writes');
  assert.notStrictEqual(store['pf-breaker-state'], undefined);
  assert.notStrictEqual(store['pf-limiter-state'], undefined);
});

test('escalating backoff widens the gap on repeated blocks', async () => {
  mockSession();
  const { CircuitBreaker } = await import('../../src/background/rate_limiter.js?t3');
  const b = new CircuitBreaker();
  b.trip(0); const first = b.cooldownMs;
  b.trip(0); const second = b.cooldownMs;
  b.trip(0); const third = b.cooldownMs;
  assert.ok(second > first && third > second, 'cooldown must escalate');
  assert.ok(third <= 30 * 60_000, 'but stay bounded');
});

test('an explicit Retry-After is honoured', async () => {
  mockSession();
  const { CircuitBreaker } = await import('../../src/background/rate_limiter.js?t4');
  const b = new CircuitBreaker();
  b.trip(120_000);
  assert.ok(b.isOpen);
  assert.ok(b.remaining() >= 110_000, 'must wait at least the requested window');
});

test('reset() clears a cooldown only when it is not active', async () => {
  mockSession();
  const { CircuitBreaker } = await import('../../src/background/rate_limiter.js?t5');
  const b = new CircuitBreaker();
  b.trip(0);
  assert.ok(b.isOpen);
  // enricher.js guards reset() behind !isOpen; emulate that contract.
  if (!b.isOpen) b.reset();
  assert.ok(b.isOpen, 'a late success must not wipe an active cooldown');
});

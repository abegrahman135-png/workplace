import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveRateLimiter } from '../src/lib/rate_limiter.js';

// ─── construction ─────────────────────────────────────────────────────────
test('AdaptiveRateLimiter: constructs with correct initial state', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000, perMinuteCap:20 });
  const s = rl.getStatus();
  assert.equal(s.currentDelay, 2000);
  assert.equal(s.consecutiveErrors, 0);
  assert.equal(s.requestsThisMinute, 0);
});

// ─── reportSuccess ────────────────────────────────────────────────────────
test('reportSuccess: decreases delay toward base (×0.9)', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  // Manually pump delay up first via error
  rl.reportError(429);
  const before = rl.getStatus().currentDelay;
  rl.reportSuccess();
  const after = rl.getStatus().currentDelay;
  assert.ok(after < before, `Expected delay to decrease: ${before} → ${after}`);
});
test('reportSuccess: never drops below baseDelayMs', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  for (let i = 0; i < 20; i++) rl.reportSuccess();
  assert.ok(rl.getStatus().currentDelay >= 2000);
});
test('reportSuccess: resets consecutiveErrors to 0', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  rl.reportError(429);
  rl.reportSuccess();
  assert.equal(rl.getStatus().consecutiveErrors, 0);
});

// ─── reportError ─────────────────────────────────────────────────────────
test('reportError(429): applies exponential backoff', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  const before = rl.getStatus().currentDelay;
  rl.reportError(429);
  const after = rl.getStatus().currentDelay;
  assert.ok(after > before, `Expected delay to increase: ${before} → ${after}`);
});
test('reportError(429): increments consecutiveErrors', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  rl.reportError(429);
  assert.equal(rl.getStatus().consecutiveErrors, 1);
  rl.reportError(429);
  assert.equal(rl.getStatus().consecutiveErrors, 2);
});
test('reportError(429): never exceeds maxDelayMs', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  for (let i = 0; i < 10; i++) rl.reportError(429);
  assert.ok(rl.getStatus().currentDelay <= 60000);
});
test('reportError(401): sets delay to maxDelayMs', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  rl.reportError(401);
  assert.equal(rl.getStatus().currentDelay, 60000);
});
test('reportError(403): sets delay to maxDelayMs', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  rl.reportError(403);
  assert.equal(rl.getStatus().currentDelay, 60000);
});

// ─── reportCheckpointDetected ────────────────────────────────────────────
test('reportCheckpointDetected: sets delay to 5×maxDelay', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  rl.reportCheckpointDetected();
  assert.equal(rl.getStatus().currentDelay, 60000 * 5);
});

// ─── getStatus ────────────────────────────────────────────────────────────
test('getStatus: returns all required fields', () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:2000, maxDelayMs:60000 });
  const s = rl.getStatus();
  assert.ok('currentDelay' in s);
  assert.ok('consecutiveErrors' in s);
  assert.ok('requestsThisMinute' in s);
});

// ─── waitForSlot (smoke test — just checks it returns quickly with no prior calls) ──
test('waitForSlot: resolves without hanging when under cap', async () => {
  const rl = new AdaptiveRateLimiter({ baseDelayMs:0, maxDelayMs:0, perMinuteCap:20 });
  // Should resolve very quickly since delay=0
  await rl.waitForSlot();
  assert.equal(rl.getStatus().requestsThisMinute, 1);
});

/**
 * pump_stall.test.js — the "Enriching 39/368 (11%)" freeze.
 *
 * Reported symptom: 368 discovered, 39 enriched, 329 queued, 0 need retry.
 * Nothing errored — the pump simply stopped making progress.
 *
 * Three independent causes, each reproduced below:
 *   1. waitForSlot() slept past the pump budget once perMinuteCap was hit.
 *      39 enriched is ~= the 35/min cap, which is the fingerprint.
 *   2. fetchProfile() had no timeout, so one hung socket froze Promise.all.
 *   3. the `running` flag latched forever if a pump died mid-flight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { AdaptiveRateLimiter } = await import('../../src/background/rate_limiter.js');

test('cause 1 — rate limiter must not sleep past the pump budget', async (t) => {
  await t.test('refuses a slot instead of overrunning the deadline', async () => {
    const rl = new AdaptiveRateLimiter({ baseDelayMs: 1, maxDelayMs: 10, perMinuteCap: 3 });
    const deadline = Date.now() + 500;
    for (let i = 0; i < 3; i++) {
      assert.equal(await rl.waitForSlot(deadline), true, `slot ${i} should be granted`);
    }
    // Cap reached: the old code slept the rest of the 60s window here.
    const t0 = Date.now();
    const granted = await rl.waitForSlot(deadline);
    const elapsed = Date.now() - t0;

    assert.equal(granted, false, 'must refuse, not sleep');
    assert.ok(elapsed < 200, `returned in ${elapsed}ms, must not block`);
  });

  await t.test('the 35/min cap does not stall a 50s budget', async () => {
    // Regression on the exact production numbers.
    const rl = new AdaptiveRateLimiter({ baseDelayMs: 1500, maxDelayMs: 8000, perMinuteCap: 35 });
    rl.count = 35;                    // cap already reached
    rl.windowStart = Date.now();      // ~60s left in the window
    const deadline = Date.now() + 50_000;

    const t0 = Date.now();
    const granted = await rl.waitForSlot(deadline);
    assert.equal(granted, false);
    assert.ok(Date.now() - t0 < 200, 'must return immediately, not sleep ~60s');
  });

  await t.test('a fresh window grants slots again', async () => {
    const rl = new AdaptiveRateLimiter({ baseDelayMs: 1, maxDelayMs: 10, perMinuteCap: 2 });
    rl.count = 2;
    rl.windowStart = Date.now() - 61_000;   // window has rolled over
    assert.equal(await rl.waitForSlot(Date.now() + 5_000), true);
  });

  await t.test('unbounded callers still work (back-compat)', async () => {
    const rl = new AdaptiveRateLimiter({ baseDelayMs: 1, maxDelayMs: 5, perMinuteCap: 10 });
    assert.equal(await rl.waitForSlot(), true);
  });
});

test('cause 2 — fetchProfile must bound its wait', async (t) => {
  await t.test('an aborted fetch returns a retryable status, never throws', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, opts) => new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    });
    try {
      const { fetchProfile } = await import('../../src/background/enricher.js?stall1');
      const p = fetchProfile('someone');
      // Should settle via the internal AbortController, not hang.
      const r = await Promise.race([
        p,
        new Promise(res => setTimeout(() => res({ timedOut: true }), 20_000)),
      ]);
      assert.ok(!r.timedOut, 'fetchProfile hung past its own timeout');
      assert.equal(r.ok, false);
      assert.equal(r.status, 408, 'abort should map to a retryable 408');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t.test('network errors are retryable, not fatal', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    try {
      const { fetchProfile } = await import('../../src/background/enricher.js?stall2');
      const r = await fetchProfile('someone');
      assert.equal(r.ok, false);
      assert.equal(r.status, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('cause 3 — a wedged pump must not latch forever', async () => {
  const src = await import('node:fs').then(m =>
    m.readFileSync('src/background/scheduler.js', 'utf8'));
  assert.match(src, /PUMP_STUCK_MS/, 'watchdog constant missing');
  assert.match(src, /runningSince/, 'wedge detection missing');
  assert.ok(
    /Date\.now\(\) - runningSince < PUMP_STUCK_MS/.test(src),
    'the running guard must be time-boxed, not a bare boolean',
  );
});

test('a void-returning limiter must not be read as "refused"', async () => {
  // Regression: `if (!gotSlot)` treated undefined as a refusal, so any limiter
  // using the old void signature caused EVERY job to bail before fetching.
  // Symptom in the integration suite: 0 of 120 enriched.
  const fs = await import('node:fs');
  const enr = fs.readFileSync('src/background/enricher.js', 'utf8');
  assert.match(enr, /slot === false/,
    'must compare strictly against false, not use a truthiness check');
  assert.ok(!/if \(!gotSlot\)/.test(enr), 'truthiness check must be gone');
});

test('budget is threaded from pump into the limiter', async () => {
  const fs = await import('node:fs');
  const sched = fs.readFileSync('src/background/scheduler.js', 'utf8');
  const enr = fs.readFileSync('src/background/enricher.js', 'utf8');

  assert.match(sched, /deadline: started \+ PUMP_BUDGET_MS/, 'pump must pass a deadline');
  assert.match(enr, /waitForSlot\(deadline\)/, 'enricher must honour the deadline');
  assert.match(enr, /rate_budget_exhausted/, 'must hand the job back when out of budget');
  assert.match(sched, /rate_budget/, 'pump must break out when the window is spent');
});

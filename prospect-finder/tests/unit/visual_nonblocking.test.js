/**
 * visual_nonblocking.test.js — "Enriching 0/471" after the vision layer shipped.
 *
 * Enabling the face model by default introduced a new way to freeze the queue.
 * The offscreen document must load a 1.3MB library plus ~620KB of weights on
 * first use. If that is slow or fails, EVERY job pays the full timeout, and the
 * dashboard sits at 0 enriched with everything still queued.
 *
 * Three independent protections, each asserted here:
 *   1. per-call timeout on the offscreen round trip;
 *   2. a circuit breaker that disables the layer after repeated failures;
 *   3. a hard outer bound in classifyTier2 so a stall degrades results
 *      rather than blocking enrichment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VISUAL_SRC = readFileSync(join(process.cwd(), 'src', 'engines', 'classifier', 'visual.js'), 'utf8');
const INDEX_SRC = readFileSync(join(process.cwd(), 'src', 'engines', 'classifier', 'index.js'), 'utf8');

test('the visual pass is hard-bounded inside tier 2', async (t) => {
  await t.test('a Promise.race caps the whole pass', () => {
    assert.match(INDEX_SRC, /Promise\.race/);
    assert.match(INDEX_SRC, /must never be able to stall enrichment/);
  });

  await t.test('a stall resolves to no signals rather than throwing', () => {
    assert.match(INDEX_SRC, /setTimeout\(\(\) => resolve\(\[\]\), \d+\)/);
  });

  await t.test('the outer bound is shorter than the pump budget', () => {
    const outer = Number(INDEX_SRC.match(/resolve\(\[\]\), (\d+)\)/)[1]);
    // PUMP_BUDGET_MS is 50s; a single job must not be able to eat it.
    assert.ok(outer <= 10_000, `outer bound ${outer}ms is too long`);
  });
});

test('the offscreen round trip has its own timeout', async (t) => {
  await t.test('detectGenderFromPic defaults to a tight timeout', () => {
    const m = VISUAL_SRC.match(/timeoutMs = (\d+)/);
    assert.ok(m, 'no timeout found');
    assert.ok(Number(m[1]) <= 8000, `timeout ${m[1]}ms too long for a queued pipeline`);
  });

  await t.test('it races the message against that timeout', () => {
    assert.match(VISUAL_SRC, /Promise\.race/);
    assert.match(VISUAL_SRC, /new Error\('timeout'\)/);
  });
});

test('circuit breaker stops a broken model from freezing the queue', async (t) => {
  // Fresh module per test: the breaker is module-level state.
  const load = async (tag) => {
    globalThis.chrome = {
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
        getContexts: async () => [],
        sendMessage: () => new Promise(() => {}),   // never resolves
      },
      offscreen: { createDocument: async () => { throw new Error('nope'); } },
    };
    return import(`../../src/engines/classifier/visual.js?nb${tag}`);
  };

  await t.test('repeated offscreen failures disable the layer', async () => {
    const v = await load('a');
    const settings = { enableVisualClassifier: true, visualFastLaneOnly: false };
    const undecided = { verdict: 'unknown', confidence: 0, signals: {} };

    assert.equal(v.shouldRunVisual(undecided, settings, 'slow'), true, 'should start enabled');

    for (let i = 0; i < 3; i++) await v.detectGenderFromPic('https://x/y.jpg');

    assert.equal(v.visualHealth().disabled, true, 'breaker never tripped');
    assert.equal(v.shouldRunVisual(undecided, settings, 'slow'), false,
      'a dead model must stop being consulted');
  });

  await t.test('a disabled layer returns no signals immediately', async () => {
    const v = await load('b');
    for (let i = 0; i < 3; i++) await v.detectGenderFromPic('https://x/y.jpg');

    const t0 = Date.now();
    const sigs = await v.visualSignals(
      'https://x/y.jpg',
      { enableVisualClassifier: true, visualFastLaneOnly: false },
      'slow',
      { verdict: 'unknown', confidence: 0, signals: {} },
      'someone',
    );
    const elapsed = Date.now() - t0;

    assert.deepEqual(sigs, []);
    assert.ok(elapsed < 200, `took ${elapsed}ms; must be instant once disabled`);
  });

  await t.test('health can be reset', async () => {
    const v = await load('c');
    for (let i = 0; i < 3; i++) await v.detectGenderFromPic('https://x/y.jpg');
    assert.equal(v.visualHealth().disabled, true);
    v._resetVisualHealth();
    assert.equal(v.visualHealth().disabled, false);
    assert.equal(v.visualHealth().fails, 0);
  });
});

test('a hanging offscreen document cannot outlast the bound', async () => {
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      sendMessage: () => new Promise(() => {}),      // hangs forever
    },
    offscreen: { createDocument: async () => {} },
  };
  const v = await import('../../src/engines/classifier/visual.js?hang');

  const t0 = Date.now();
  const r = await v.detectGenderFromPic('https://x/y.jpg', { timeoutMs: 300 });
  const elapsed = Date.now() - t0;

  assert.equal(r, null, 'a hang must resolve to null, not reject');
  assert.ok(elapsed < 2000, `waited ${elapsed}ms on a hung offscreen document`);
});

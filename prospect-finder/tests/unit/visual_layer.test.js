/**
 * visual_layer.test.js — the ML/vision tier.
 *
 * Context: the dashboard showed many "Unknown" gender badges because the six
 * text signal generators have no entry for names like "Alfi Jawad", "Madhobi"
 * or "Mohaimen". The face model is the escalation path for exactly those.
 *
 * The model weights are now BUNDLED (public/face-api/, ~1.9MB). Numbers in the
 * calibration test below were MEASURED by running the real bundled weights over
 * real photographs via @tensorflow/tfjs-node:
 *
 *   woman A  p=0.9701 det=0.960 -> female
 *   woman B  p=0.8708 det=0.680 -> female
 *   man A    p=0.9870 det=0.925 -> male
 *   man B    p=0.9769 det=0.429 -> male   (confident class, WEAK detection)
 *   man C    p=0.9894 det=0.768 -> male
 *   blank image -> 0 faces
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { PRIOR, SATURATION, combine, signal, verdictFor } =
  await import('../../src/engines/classifier/evidence.js');
const { shouldRunVisual } = await import('../../src/engines/classifier/visual.js');
const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');

const OFFSCREEN = readFileSync(join(process.cwd(), 'src', 'ui', 'offscreen.js'), 'utf8');

/** The exact confidence formula implemented in offscreen.js. */
const visConf = (p, det) =>
  Math.round(((p >= 0.9 ? 0.9 : p >= 0.8 ? 0.75 : p >= 0.65 ? 0.5 : 0.25)
            * (det >= 0.8 ? 1 : det >= 0.6 ? 0.85 : 0.7)) * 100) / 100;

const visScore = (p, gender) => gender === 'female' ? Math.round(p * 100) : Math.round((1 - p) * 100);

const MEASURED = [
  { n: 'woman A', p: 0.9701, det: 0.960, gender: 'female', expect: 'likely_female' },
  { n: 'woman B', p: 0.8708, det: 0.680, gender: 'female', expect: 'likely_female' },
  { n: 'man A',   p: 0.9870, det: 0.925, gender: 'male',   expect: 'likely_male' },
  { n: 'man B',   p: 0.9769, det: 0.429, gender: 'male',   expect: 'likely_male' },
  { n: 'man C',   p: 0.9894, det: 0.768, gender: 'male',   expect: 'likely_male' },
];

test('model assets are actually bundled', async (t) => {
  const base = join(process.cwd(), 'public', 'face-api');

  await t.test('the library is present and non-trivial', () => {
    const lib = join(base, 'face-api.esm.js');
    assert.ok(existsSync(lib), 'face-api.esm.js missing');
    assert.ok(statSync(lib).size > 500_000, 'library looks truncated');
  });

  await t.test('both nets have real binary weights', () => {
    for (const [f, min] of [['tiny_face_detector_model.bin', 150_000],
                            ['age_gender_model.bin', 400_000]]) {
      const p = join(base, 'models', f);
      assert.ok(existsSync(p), `${f} missing`);
      assert.ok(statSync(p).size > min, `${f} too small to be real weights`);
    }
  });

  await t.test('manifests point at the .bin files that exist', () => {
    for (const m of ['tiny_face_detector_model-weights_manifest.json',
                     'age_gender_model-weights_manifest.json']) {
      const j = JSON.parse(readFileSync(join(base, 'models', m), 'utf8'));
      for (const grp of j) for (const path of grp.paths) {
        assert.ok(existsSync(join(base, 'models', path)), `manifest references missing ${path}`);
      }
    }
  });

  await t.test('the manifest exposes them as web-accessible', () => {
    const mf = JSON.parse(readFileSync(join(process.cwd(), 'manifest.json'), 'utf8'));
    const res = mf.web_accessible_resources.flatMap(r => r.resources);
    assert.ok(res.some(r => r.startsWith('public/face-api')), 'face-api not web-accessible');
    assert.ok(mf.permissions.includes('offscreen'), 'offscreen permission missing');
  });
});

test('the layer is enabled by default now that weights ship', async (t) => {
  await t.test('visual classifier is on', () => {
    assert.equal(DEFAULT_SETTINGS.enableVisualClassifier, true);
  });
  await t.test('it is not restricted to the fast lane', () => {
    // Uncertain profiles triage into SLOW; a fast-lane-only rule meant the
    // layer never ran on the profiles that actually needed it.
    assert.equal(DEFAULT_SETTINGS.visualFastLaneOnly, false);
  });
});

test('calibration against measured model output', async (t) => {
  await t.test('every real photo resolves to the correct verdict', () => {
    for (const m of MEASURED) {
      const ev = combine([signal('visual', visScore(m.p, m.gender), visConf(m.p, m.det))]);
      assert.equal(ev.verdict, m.expect, `${m.n}: got ${ev.verdict} @ ${ev.confidence}`);
    }
  });

  await t.test('a correct call must clear the 0.35 unknown floor', () => {
    // Regression: at the old visual prior of 0.75, woman B combined to 0.34 and
    // stayed "unknown" despite an 87% correct call.
    for (const m of MEASURED) {
      const ev = combine([signal('visual', visScore(m.p, m.gender), visConf(m.p, m.det))]);
      assert.ok(ev.confidence >= 0.35, `${m.n} stuck below the floor at ${ev.confidence}`);
    }
  });

  await t.test('a weak prediction still yields unknown', () => {
    const ev = combine([signal('visual', visScore(0.62, 'female'), visConf(0.62, 0.55))]);
    assert.equal(ev.verdict, 'unknown');
  });

  await t.test('vision alone never reaches the hard-exclude threshold', () => {
    // scoring.js excludes at confidence >= 0.55. A photo must not be able to
    // exclude someone by itself — it can only damp the score.
    for (const m of MEASURED) {
      const ev = combine([signal('visual', visScore(m.p, m.gender), visConf(m.p, m.det))]);
      assert.ok(ev.confidence < 0.55, `${m.n} could hard-exclude on a photo alone`);
    }
  });

  await t.test('a photo is never even requested for a confident name', () => {
    // Combining is a weighted average, so a contradicting 0.9 photo would drag
    // a certain nameExact hit to "ambiguous". The guard is to not run at all.
    const decided = {
      verdict: 'likely_female', confidence: 0.71,
      signals: { nameExact: { value: 94, confidence: 1.0 } },
    };
    assert.equal(shouldRunVisual(decided, DEFAULT_SETTINGS, 'slow'), false);
  });

  await t.test('but it still runs when the name gave nothing', () => {
    const undecided = { verdict: 'unknown', confidence: 0, signals: {} };
    assert.equal(shouldRunVisual(undecided, DEFAULT_SETTINGS, 'slow'), true);
  });
});

test('offscreen guards against unreliable inputs', async (t) => {
  await t.test('rejects group photos', () => {
    assert.match(OFFSCREEN, /multiple_faces/);
  });
  await t.test('rejects tiny faces', () => {
    assert.match(OFFSCREEN, /face_too_small/);
    assert.match(OFFSCREEN, /minSide < 40/);
  });
  await t.test('folds detection quality into confidence', () => {
    assert.match(OFFSCREEN, /best\.detection\.score/);
    assert.ok(visConf(0.98, 0.43) < visConf(0.98, 0.93),
      'a weak detection must lower confidence');
  });
  await t.test('loads weights from the models directory', () => {
    assert.match(OFFSCREEN, /const modelDir = base \+ 'models'/);
  });
});

test('escalation targets only the uncertain', async (t) => {
  const S = DEFAULT_SETTINGS;
  await t.test('runs on the Unknown profiles from the dashboard', () => {
    assert.equal(shouldRunVisual({ verdict: 'unknown', confidence: 0 }, S, 'slow'), true);
  });
  await t.test('runs on ambiguous', () => {
    assert.equal(shouldRunVisual({ verdict: 'ambiguous', confidence: 0.4 }, S, 'normal'), true);
  });
  await t.test('skips names already decided', () => {
    assert.equal(shouldRunVisual({ verdict: 'likely_female', confidence: 0.95 }, S, 'fast'), false);
  });
  await t.test('honours the off switch', () => {
    const off = { ...S, enableVisualClassifier: false };
    assert.equal(shouldRunVisual({ verdict: 'unknown', confidence: 0 }, off, 'fast'), false);
  });
});

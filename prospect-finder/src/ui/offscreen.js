/**
 * offscreen.js — Host for image analysis (needs a real DOM + canvas).
 * v1 tried importScripts() inside a module service worker, which always
 * throws, so this signal was dead 100% of the time.
 *
 * The face model itself is NOT bundled by default (it is ~6MB and carries
 * biometric-compliance weight). If public/face-api/ is absent this responds
 * "unavailable" and the pipeline continues without the visual signal.
 */

let ready = null;

async function ensure() {
  if (ready) return ready;
  ready = (async () => {
    try {
      const base = chrome.runtime.getURL('public/face-api/');
      // A HEAD request against an extension URL is not reliably answered;
      // just attempt the import and let a failure fall through to null.
      const mod = await import(base + 'face-api.esm.js');
      // loadFromUri() appends '/<model>-weights_manifest.json', so pass the
      // models DIRECTORY without a trailing slash.
      const modelDir = base + 'models';
      await Promise.all([
        mod.nets.tinyFaceDetector.loadFromUri(modelDir),
        mod.nets.ageGenderNet.loadFromUri(modelDir),
      ]);
      return mod;
    } catch (_) {
      return null;
    }
  })();
  return ready;
}

chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (msg?.type !== 'OFFSCREEN_ANALYZE_FACE') return;
  (async () => {
    const faceapi = await ensure();
    if (!faceapi) return respond({ detected: false, reason: 'model_unavailable' });
    try {
      // Prefer the cached blob: the harvested CDN URL is HMAC-signed and has
      // very likely expired by the time this runs.
      let blob = null;
      if (msg.username) {
        try {
          const { getAvatar } = await import(chrome.runtime.getURL('src/db/repo.avatars.js'));
          const row = await getAvatar(msg.username);
          if (row?.blob) blob = row.blob;
        } catch (_) { /* fall through to the network */ }
      }
      if (!blob) {
        if (!msg.url) return respond({ detected: false, reason: 'no_image' });
        const res = await fetch(msg.url);
        if (!res.ok) return respond({ detected: false, reason: 'fetch_failed' });
        blob = await res.blob();
      }
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();

      const dets = await faceapi
        .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.4 }))
        .withAgeAndGender();
      if (!dets?.length) return respond({ detected: false, reason: 'no_face' });

      // Group shots are ambiguous: which face is the account owner? Only trust
      // a photo whose largest face clearly dominates.
      const byArea = [...dets].sort((a, b) => b.detection.box.area - a.detection.box.area);
      const best = byArea[0];
      if (byArea.length > 1 && byArea[1].detection.box.area > best.detection.box.area * 0.6) {
        return respond({ detected: false, reason: 'multiple_faces' });
      }

      const p = best.genderProbability;      // confidence in the predicted class
      const det = best.detection.score;      // how sure we are it IS a face

      // Tiny crops carry little signal regardless of what the net reports.
      const box = best.detection.box;
      const minSide = Math.min(box.width, box.height);
      if (minSide < 40) return respond({ detected: false, reason: 'face_too_small' });

      // Combine both: a confident gender call on a weak detection is not
      // trustworthy (observed detScore 0.429 with p=0.977 on a real photo).
      let confidence = (p >= 0.9 ? 0.9 : p >= 0.8 ? 0.75 : p >= 0.65 ? 0.5 : 0.25)
                     * (det >= 0.8 ? 1 : det >= 0.6 ? 0.85 : 0.7);
      confidence = Math.round(confidence * 100) / 100;

      respond({
        detected: true,
        score: best.gender === 'female' ? Math.round(p * 100) : Math.round((1 - p) * 100),
        confidence,
        detail: { p: Number(p.toFixed(3)), det: Number(det.toFixed(3)), age: Math.round(best.age) },
      });
    } catch (_) {
      respond({ detected: false });
    }
  })();
  return true;
});

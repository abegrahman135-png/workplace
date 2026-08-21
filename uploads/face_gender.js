/**
 * face_gender.js — Profile picture gender detection using face-api.js
 * 
 * Loads TinyFaceDetector + AgeGenderNet models from bundled public/face-api/
 * Fetches profile pic via service worker (no CORS restriction in SW context)
 * Returns { score: 0-100, confidence: 'high'|'medium'|'low', detected: bool }
 * 
 * Score: 100 = certainly female, 0 = certainly male
 */

let faceApiLoaded = false;
let modelsLoaded  = false;

// Lazy-load face-api.js from the extension bundle
async function ensureFaceApi() {
  if (faceApiLoaded) return;
  try {
    // face-api.js is bundled as a UMD at public/face-api/face-api.min.js
    // In service worker context we use importScripts
    importScripts(chrome.runtime.getURL('public/face-api/face-api.min.js'));
    faceApiLoaded = true;
  } catch (e) {
    console.warn('[face_gender] Could not load face-api.js:', e.message);
    faceApiLoaded = false;
    throw e;
  }
}

async function ensureModels() {
  if (modelsLoaded) return;
  await ensureFaceApi();
  const MODEL_URL = chrome.runtime.getURL('public/face-api/models');
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
}

/**
 * Fetch a profile picture and run gender detection.
 * @param {string} picUrl - Instagram CDN URL of profile picture
 * @returns {{ score: number, confidence: string, detected: boolean }}
 */
export async function detectGenderFromPic(picUrl) {
  if (!picUrl) return { score: 50, confidence: 'none', detected: false };

  try {
    await ensureModels();

    // Fetch image as blob via service worker (bypasses CORS)
    const resp = await fetch(picUrl, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();

    // Convert blob to ImageBitmap (available in service workers)
    const bitmap = await createImageBitmap(blob);

    // Run face detection + gender
    const detections = await faceapi
      .detectAllFaces(bitmap, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.3 }))
      .withAgeAndGender();

    bitmap.close();

    if (!detections || detections.length === 0) {
      return { score: 50, confidence: 'low', detected: false };
    }

    // Use the largest/most prominent face
    const best = detections.reduce((a, b) =>
      (a.detection.box.area > b.detection.box.area ? a : b)
    );

    // face-api returns gender: 'female'|'male', genderProbability: 0-1
    const isFemale = best.gender === 'female';
    const prob     = best.genderProbability;
    // Convert to 0-100 female score
    const score    = isFemale ? Math.round(prob * 100) : Math.round((1 - prob) * 100);
    const confidence = prob >= 0.80 ? 'high' : prob >= 0.60 ? 'medium' : 'low';

    return { score, confidence, detected: true, age: Math.round(best.age) };
  } catch (e) {
    console.warn('[face_gender] Detection failed:', e.message);
    return { score: 50, confidence: 'error', detected: false };
  }
}

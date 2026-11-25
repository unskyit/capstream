/**
 * CapStream — Whisper Speech Recognition Client & Offline Cache Manager
 * Uses official long-term Hugging Face ONNX Whisper models cached locally in the browser.
 */

export const MODELS = [
  {
    id: "onnx-community/whisper-tiny_timestamped",
    name: "Fast (Whisper Tiny)",
    sizeMB: 67,
    size: "~67 MB",
    note: "Fastest download & mobile-friendly. Great for clear voice.",
  },
  {
    id: "onnx-community/whisper-base_timestamped",
    name: "Balanced (Whisper Base)",
    sizeMB: 103,
    size: "~103 MB",
    note: "Recommended for most creators & podcasts.",
  },
  {
    id: "onnx-community/whisper-small_timestamped",
    name: "Accurate (Whisper Small)",
    sizeMB: 275,
    size: "~275 MB",
    note: "Best accuracy for accents, fast speech & background music.",
  },
];

export const LANGUAGES = [
  ["auto", "Auto-Detect Language"],
  ["en", "English"], ["hi", "Hindi"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"],
  ["de", "German"], ["it", "Italian"], ["nl", "Dutch"], ["ru", "Russian"], ["uk", "Ukrainian"],
  ["tr", "Turkish"], ["pl", "Polish"], ["ar", "Arabic"], ["ur", "Urdu"], ["bn", "Bengali"],
  ["ta", "Tamil"], ["te", "Telugu"], ["mr", "Marathi"], ["gu", "Gujarati"], ["kn", "Kannada"],
  ["ml", "Malayalam"], ["pa", "Punjabi"], ["id", "Indonesian"], ["ms", "Malay"], ["vi", "Vietnamese"],
  ["th", "Thai"], ["tl", "Tagalog"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"],
  ["sv", "Swedish"], ["no", "Norwegian"], ["da", "Danish"], ["fi", "Finnish"], ["cs", "Czech"],
  ["sk", "Slovak"], ["ro", "Romanian"], ["hu", "Hungarian"], ["el", "Greek"], ["he", "Hebrew"],
  ["fa", "Persian"], ["bg", "Bulgarian"], ["sr", "Serbian"], ["hr", "Croatian"], ["kk", "Kazakh"],
  ["uz", "Uzbek"], ["az", "Azerbaijani"], ["ka", "Georgian"], ["sw", "Swahili"], ["af", "Afrikaans"],
  ["ca", "Catalan"], ["ne", "Nepali"], ["lt", "Lithuanian"], ["lv", "Latvian"], ["et", "Estonian"],
];

export function defaultModel() {
  if (typeof navigator === "undefined") return MODELS[1].id;
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return (isMobile ? MODELS[0] : MODELS[1]).id;
}

export function getModelInfo(id) {
  return MODELS.find((m) => m.id === id) || MODELS[1];
}

/** Check which Whisper models are already cached offline on this device */
export async function getCachedModels() {
  const cached = new Set();
  if (typeof caches === "undefined") return cached;
  try {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const reqs = await cache.keys();
      for (const req of reqs) {
        for (const m of MODELS) {
          if (req.url.includes(m.id) && req.url.includes(".onnx")) {
            cached.add(m.id);
          }
        }
      }
    }
  } catch {
    // Ignore cache inspection errors
  }
  return cached;
}

/** Clear cached Whisper models to free device storage */
export async function clearModelCache() {
  if (typeof caches === "undefined") return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((n) => n.includes("transformers") || n.includes("capstream-models"))
      .map((n) => caches.delete(n))
  );
}

let worker = null;

function getWorker() {
  return (worker ??= new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" }));
}

/** Pre-download and cache a Whisper model for 100% offline use */
export function preloadModel(modelId, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const current = getWorker();
    const cleanup = () => {
      current.removeEventListener("message", onMsg);
      current.removeEventListener("error", onErr);
      signal?.removeEventListener("abort", onAbort);
    };
    const kill = () => {
      cleanup();
      current.terminate();
      worker = null;
    };
    const onAbort = () => {
      kill();
      reject(new DOMException("Download cancelled", "AbortError"));
    };
    const onErr = (e) => {
      kill();
      reject(new Error(e.message || "Failed to download Whisper model."));
    };
    const onMsg = ({ data }) => {
      if (data.type === "download") {
        onProgress?.({
          ratio: data.ratio,
          loadedMB: (data.loadedBytes || 0) / (1024 * 1024),
          totalMB: (data.totalBytes || 0) / (1024 * 1024),
          speedMBps: (data.speedBps || 0) / (1024 * 1024),
          file: data.file,
          cached: !!data.cached,
        });
      } else if (data.type === "preloaded") {
        cleanup();
        resolve(modelId);
      } else if (data.type === "error") {
        kill();
        reject(new Error(data.message));
      }
    };
    current.addEventListener("message", onMsg);
    current.addEventListener("error", onErr);
    signal?.addEventListener("abort", onAbort);
    current.postMessage({ type: "preload", model: modelId });
  });
}

/** Transcribes 16 kHz mono Float32Array audio with zero-copy ArrayBuffer transfer. */
export function transcribeAudio(audio, options) {
  return new Promise((resolve, reject) => {
    const current = getWorker();
    const cleanup = () => {
      current.removeEventListener("message", onMessage);
      current.removeEventListener("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const kill = () => {
      cleanup();
      current.terminate();
      worker = null;
    };
    const onAbort = () => {
      kill();
      reject(new DOMException("Transcription cancelled", "AbortError"));
    };
    const onError = (e) => {
      kill();
      reject(new Error(e.message || "Speech model stopped unexpectedly. Try the Fast (Tiny) model."));
    };
    const onMessage = ({ data }) => {
      if (data.type === "download") {
        options.onProgress?.("model", data.ratio, {
          file: data.file,
          loadedMB: (data.loadedBytes || 0) / (1024 * 1024),
          totalMB: (data.totalBytes || 0) / (1024 * 1024),
          speedMBps: (data.speedBps || 0) / (1024 * 1024),
          cached: !!data.cached,
        });
      } else if (data.type === "progress") {
        options.onProgress?.("transcribe", data.ratio, { chunk: data.chunk, totalChunks: data.totalChunks });
      } else if (data.type === "language") {
        options.onLanguage?.(data.language);
      } else if (data.type === "result") {
        cleanup();
        resolve({ words: data.words, language: data.language });
      } else if (data.type === "error") {
        kill();
        reject(new Error(data.message));
      }
    };
    current.addEventListener("message", onMessage);
    current.addEventListener("error", onError);
    options.signal?.addEventListener("abort", onAbort);
    current.postMessage({ type: "transcribe", audio, model: options.model, language: options.language }, [audio.buffer]);
  });
}

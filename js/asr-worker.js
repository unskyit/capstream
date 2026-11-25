/**
 * CapStream — Whisper Speech Recognition Web Worker (Powered by Unskyit)
 * Runs 100% locally in WebAssembly via Transformers.js.
 * Streams exact MB, % and speed telemetry during first-time model caching.
 */
const RUNTIME_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
let runtimePromise;

function getRuntime() {
  return (runtimePromise ??= import(RUNTIME_URL));
}

const RATE = 16000;
const WINDOW = 28 * RATE;
const SEARCH_FROM = 18 * RATE;

let recognizer = null;
let loadedModel = "";

async function loadModel(modelId) {
  if (recognizer && loadedModel === modelId) {
    self.postMessage({ type: "download", ratio: 1, loadedBytes: 0, totalBytes: 0, speedBps: 0, cached: true });
    return recognizer;
  }
  const { env, pipeline } = await getRuntime();
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  const wasm = env?.backends?.onnx?.wasm;
  if (wasm) {
    wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
      : 1;
  }

  const files = new Map();
  const startedAt = performance.now();

  recognizer = await pipeline("automatic-speech-recognition", modelId, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (!p.file) return;
      if (p.status === "progress" && p.total) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let done = 0, total = 0;
        for (const f of files.values()) {
          done += f.loaded;
          total += f.total;
        }
        const elapsed = Math.max(0.1, (performance.now() - startedAt) / 1000);
        self.postMessage({
          type: "download",
          ratio: total ? done / total : 0,
          loadedBytes: done,
          totalBytes: total,
          speedBps: done / elapsed,
          file: p.file,
          cached: false,
        });
      }
    },
  });
  loadedModel = modelId;
  self.postMessage({ type: "model-ready", model: modelId });
  return recognizer;
}

function planWindows(audio) {
  const windows = [];
  const frame = RATE / 50;
  let start = 0;
  while (audio.length - start > WINDOW) {
    let best = start + WINDOW;
    let quietest = Infinity;
    for (let at = start + SEARCH_FROM; at + frame <= start + WINDOW; at += frame) {
      let energy = 0;
      for (let i = at; i < at + frame; i++) energy += audio[i] * audio[i];
      if (energy < quietest) {
        quietest = energy;
        best = at + frame / 2;
      }
    }
    windows.push([start, best]);
    start = best;
  }
  if (audio.length - start > RATE * 0.1) windows.push([start, audio.length]);
  return windows;
}

function isSilent(chunk) {
  let peak = 0;
  for (let i = 0; i < chunk.length; i += 8) {
    const v = Math.abs(chunk[i]);
    if (v > peak) peak = v;
  }
  return peak < 0.004;
}

async function detectLanguage(recognize, audio) {
  try {
    const config = recognize.model.generation_config;
    const languages = config?.lang_to_id;
    const start = config?.decoder_start_token_id;
    if (!languages || start === undefined) return "en";
    const { Tensor } = await getRuntime();
    const { input_features } = await recognize.processor(audio);
    const { logits } = await recognize.model({
      input_features,
      decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(start)]), [1, 1]),
    });
    const vocab = logits.dims[logits.dims.length - 1];
    const scores = logits.data.subarray(logits.data.length - vocab);
    let best = "en", top = -Infinity;
    for (const [token, id] of Object.entries(languages)) {
      if (scores[id] > top) {
        top = scores[id];
        best = token.replace(/[<|>]/g, "");
      }
    }
    return best;
  } catch {
    return "en";
  }
}

const NON_SPEECH = /^[\[(♪*].*[\])♪*]$|^♪+$/;

async function transcribe(request) {
  const recognize = await loadModel(request.model);
  const windows = planWindows(request.audio);
  self.postMessage({ type: "progress", ratio: 0, chunk: 0, totalChunks: windows.length });

  let language = request.language;
  if (language === "auto") {
    const speech = windows.find(([a, b]) => !isSilent(request.audio.subarray(a, b)));
    language = speech ? await detectLanguage(recognize, request.audio.subarray(speech[0], speech[1])) : "en";
    self.postMessage({ type: "language", language });
  }

  const words = [];
  for (let idx = 0; idx < windows.length; idx++) {
    const [from, to] = windows[idx];
    const chunk = request.audio.subarray(from, to);
    if (!isSilent(chunk)) {
      const result = await recognize(chunk, {
        return_timestamps: "word",
        language,
        task: "transcribe",
      });
      const base = from / RATE;
      for (const c of result.chunks ?? []) {
        const text = (c.text || "").trim();
        const [start, end] = c.timestamp || [null, null];
        if (!text || start === null || NON_SPEECH.test(text)) continue;
        words.push({ text, start: base + start, end: base + (end ?? start + 0.3) });
      }
    }
    self.postMessage({
      type: "progress",
      ratio: to / Math.max(1, request.audio.length),
      chunk: idx + 1,
      totalChunks: windows.length,
    });
  }
  self.postMessage({ type: "result", words, language });
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "preload") {
    loadModel(data.model)
      .then(() => self.postMessage({ type: "preloaded", model: data.model }))
      .catch((err) => self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (data.type === "transcribe") {
    transcribe(data).catch((err) => {
      self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    });
  }
});

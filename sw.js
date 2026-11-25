/**
 * CapStream — Offline-First PWA Service Worker v3 (Powered by Unskyit)
 * Caches app shell, local fonts, pinned CDN runtimes, and Whisper ONNX models.
 */

const SHELL_CACHE = "capstream-shell-v3";
const RUNTIME_CACHE = "capstream-runtime-v3";
const MODEL_CACHE = "capstream-models-v3";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.svg",
  "./css/styles.css",
  "./fonts/font-manifest.json",
  "./js/app.js",
  "./js/store.js",
  "./js/templates.js",
  "./js/renderer.js",
  "./js/fonts.js",
  "./js/segment.js",
  "./js/timeline.js",
  "./js/media.js",
  "./js/asr-client.js",
  "./js/asr-worker.js",
  "./js/exporter.js",
  "./js/batch.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, RUNTIME_CACHE, MODEL_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isModelUrl(url) {
  return (
    url.hostname.includes("huggingface.co") ||
    url.hostname.includes("hf.co") ||
    url.pathname.endsWith(".onnx") ||
    url.pathname.endsWith(".wasm")
  );
}

function isPinnedCdnUrl(url) {
  return url.hostname === "cdn.jsdelivr.net";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 1. Whisper ONNX models & WASM binaries -> Cache-First
  if (isModelUrl(url)) {
    event.respondWith(
      caches.open(MODEL_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })
    );
    return;
  }

  // 2. Pinned CDN libraries -> Cache-First
  if (isPinnedCdnUrl(url)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })
    );
    return;
  }

  // 3. Same-origin app shell & local .woff2 fonts -> Network-First with Cache Fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch {
          return (await cache.match(req)) || Response.error();
        }
      })
    );
  }
});

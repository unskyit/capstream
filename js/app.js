/**
 * CapStream — Main Application Controller (Powered by Unskyit)
 * Buttery 60fps Preview • Mobile-First Polish • Browser History • Custom Presets • Per-Setting Reset • Safe-Zone Overlay • Loop • Original-Res Export
 */
import { clearModelCache, defaultModel, getCachedModels, getModelInfo, LANGUAGES, MODELS, preloadModel, transcribeAudio } from "./asr-client.js";
import { applyVocabulary, createBatchItem, parseVocabulary } from "./batch.js";
import { detectCapabilities, exportProject } from "./exporter.js";
import { ensureFont, getFontNames, glyphsOf, loadFontManifest, onFontsChanged, weightsFor } from "./fonts.js";
import { extractAudio, probeMedia, tightenWords } from "./media.js";
import { cutsFor, DEFAULT_FRAME, DEFAULT_FX, frameSize, renderScene } from "./renderer.js";
import { normalizeWords, pageStart, pageText, resegment, retimeWords, segmentWords, uid } from "./segment.js";
import { createEmptyDoc, idbGet, idbSet, store } from "./store.js";
import { getTemplate, TEMPLATES } from "./templates.js";
import { cutTotal, downloadBlob, formatTime, parseSubtitles, skipTarget, toAss, toOutputTime, toPlainText, toSourceTime, toSrt, toVtt } from "./timeline.js";

const $ = (id) => document.getElementById(id);

const ICON_PLAY = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const ICON_PAUSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
const ICON_RESET = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

const USER_PRESETS_KEY = "capstream-user-presets-v1";

let procAbort = null;
let procTimer = null;
let expAbort = null;
let preloadAbort = null;
let deferredInstallPrompt = null;
let rafId = null;
let previewCtx = null;
let lastUiTick = 0;
let selectedExportMode = "mp4-h264";
let safeZoneMode = "off";
let isLooping = false;
let capabilities = null;
let cachedModels = new Set();
let userPresets = [];
let batchQueue = [];

/* ==========================================================================
   Navigation History (Clean Back Button Support on Mobile & Desktop)
   ========================================================================== */
function pushNavState(view) {
  try {
    if (history.state?.view !== view) {
      history.pushState({ view }, "");
    }
  } catch {}
}

window.addEventListener("popstate", (e) => {
  const modal = $("exportModal");
  if (modal.classList.contains("open")) {
    if (!expAbort) modal.classList.remove("open");
    return;
  }
  const target = e.state?.view;
  const st = store.get();
  if (target === "studio" && st.file) {
    store.set({ screen: "studio" });
  } else if (target === "batch") {
    stopPlayback();
    store.set({ screen: "batch" });
  } else {
    stopPlayback();
    store.set({ screen: "upload" });
  }
});

/* ==========================================================================
   PWA Service Worker & Native Install Prompt
   ========================================================================== */
function setupPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then(() => updateOnlineBadge()).catch(() => {});
  }
  window.addEventListener("online", updateOnlineBadge);
  window.addEventListener("offline", updateOnlineBadge);
  updateOnlineBadge();

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $("btnInstallPwa").style.display = "inline-flex";
  });

  $("btnInstallPwa").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === "accepted") $("btnInstallPwa").style.display = "none";
    deferredInstallPrompt = null;
  });

  window.addEventListener("appinstalled", () => {
    $("btnInstallPwa").style.display = "none";
    $("pwaStatusText").textContent = "Installed";
    $("pwaStatusBadge").classList.add("ok");
  });
}

function updateOnlineBadge() {
  const badge = $("pwaStatusBadge");
  const text = $("pwaStatusText");
  if (!badge || !text) return;
  if (!navigator.onLine) {
    text.textContent = "Offline";
    badge.classList.add("ok");
  } else {
    text.textContent = cachedModels.size > 0 ? "Offline Ready" : "PWA Ready";
    badge.classList.toggle("ok", cachedModels.size > 0);
  }
}

function renderModelSegmented() {
  const wrap = $("modelSegmented");
  const selId = $("selModel").value;
  wrap.innerHTML = "";
  const shortNames = ["Fast", "Balanced", "Accurate"];
  MODELS.forEach((m, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `seg-btn ${m.id === selId ? "active" : ""}`;
    const isCached = cachedModels.has(m.id);
    btn.innerHTML = `<span class="t">${shortNames[i] || m.name}</span><span class="s">${isCached ? "Cached ✓" : `${m.sizeMB} MB`}</span>`;
    btn.onclick = () => {
      $("selModel").value = m.id;
      refreshModelCacheUI();
    };
    wrap.appendChild(btn);
  });
}

async function refreshModelCacheUI() {
  cachedModels = await getCachedModels();
  renderModelSegmented();

  const selId = $("selModel").value;
  const info = getModelInfo(selId);
  const isCached = cachedModels.has(selId);
  const badge = $("modelCacheBadge");
  const badgeText = $("modelCacheText");
  const note = $("modelSizeNote");
  const btnPre = $("btnPreloadModel");
  const btnClr = $("btnClearCache");

  if (isCached) {
    badgeText.textContent = "Cached Offline";
    badge.className = "pill-status ok";
    note.textContent = `${info.size} saved locally.`;
    btnPre.style.display = "none";
  } else {
    badgeText.textContent = `${info.size}`;
    badge.className = "pill-status";
    note.textContent = "Caches once for offline use.";
    btnPre.style.display = "inline-flex";
  }
  btnClr.style.display = cachedModels.size > 0 ? "inline-flex" : "none";
  updateOnlineBadge();
}

/* ==========================================================================
   Initialization
   ========================================================================== */
async function init() {
  setupPwa();
  try { history.replaceState({ view: "upload" }, ""); } catch {}

  const langSel = $("selLanguage");
  for (const [code, name] of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name;
    langSel.appendChild(opt);
  }

  const modelSel = $("selModel");
  const defModel = defaultModel();
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === defModel) opt.selected = true;
    modelSel.appendChild(opt);
  }

  const batchStyleSel = $("batchStyleSel");
  for (const t of TEMPLATES) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name}${t.category === "viral" ? " ★" : ""}`;
    batchStyleSel.appendChild(opt);
  }

  userPresets = (await idbGet(USER_PRESETS_KEY)) || [];
  await loadFontManifest();
  capabilities = await detectCapabilities();
  $("capDiskText").textContent = capabilities.diskStream ? "Disk-Stream" : "Standard Save";
  $("expDiskStream").checked = capabilities.diskStream;
  $("expDiskStream").disabled = !capabilities.diskStream;
  updateExportCapabilityNote();

  await refreshModelCacheUI();

  const draft = await store.loadDraft();
  if (draft?.file && draft?.meta && draft?.doc) {
    $("draftBannerText").textContent = `Resume: ${draft.meta.name}`;
    $("draftBanner").classList.add("visible");
  }

  bindEvents();
  onFontsChanged(() => drawPreviewFrame(true));
  store.subscribe(onStateChange);
  onStateChange(store.get());
}

function updateExportCapabilityNote() {
  if (!capabilities) return;
  const parts = [];
  parts.push(capabilities.diskStream ? "Disk-stream ready (flat RAM)" : "Memory buffer download");
  if (selectedExportMode === "webm-alpha") {
    parts.push(capabilities.vp9Alpha ? "VP9 Alpha supported ✓" : "VP9 Alpha unsupported — use Chroma MP4 or PNG Folder");
  } else if (selectedExportMode === "mp4-hevc") {
    parts.push(capabilities.hevc ? "H.265/HEVC supported ✓" : "HEVC unsupported — falls back to H.264 MP4");
  }
  $("expCapabilityNote").textContent = parts.join(" • ");
}

/* ==========================================================================
   Event Bindings
   ========================================================================== */
function bindEvents() {
  const dz = $("dropzone");
  const fileInput = $("fileInput");

  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f) startMediaWorkflow(f);
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (f) startMediaWorkflow(f);
  });

  $("btnPreloadModel").addEventListener("click", async () => {
    const modelId = $("selModel").value;
    const info = getModelInfo(modelId);
    $("uploadError").classList.remove("visible");
    $("preloadProgressWrap").classList.add("visible");
    $("btnPreloadModel").disabled = true;
    $("preloadText").textContent = `Downloading ${info.size}…`;
    $("preloadPct").textContent = "0.0%";
    $("preloadBar").style.width = "2%";
    preloadAbort = new AbortController();

    try {
      await preloadModel(
        modelId,
        (p) => {
          const pct = Math.min(100, p.ratio * 100);
          const tot = p.totalMB > 0 ? p.totalMB : info.sizeMB;
          const spd = p.speedMBps > 0.05 ? ` • ${p.speedMBps.toFixed(1)} MB/s` : "";
          $("preloadText").textContent = p.cached ? "Cached ✓" : `${p.loadedMB.toFixed(1)} / ${tot.toFixed(1)} MB${spd}`;
          $("preloadPct").textContent = `${pct.toFixed(1)}%`;
          $("preloadBar").style.width = `${Math.max(2, pct)}%`;
        },
        preloadAbort.signal
      );
      $("preloadText").textContent = "Cached offline ✓";
      $("preloadPct").textContent = "100.0%";
      $("preloadBar").style.width = "100%";
      await refreshModelCacheUI();
      setTimeout(() => $("preloadProgressWrap").classList.remove("visible"), 1500);
    } catch (err) {
      if (err?.name !== "AbortError") {
        $("uploadError").textContent = err instanceof Error ? err.message : String(err);
        $("uploadError").classList.add("visible");
      }
      $("preloadProgressWrap").classList.remove("visible");
    } finally {
      preloadAbort = null;
      $("btnPreloadModel").disabled = false;
    }
  });

  $("btnClearCache").addEventListener("click", async () => {
    await clearModelCache();
    await refreshModelCacheUI();
  });

  $("chkLiveTelemetry").addEventListener("change", (e) => store.set({ showLiveTelemetry: e.target.checked }));

  $("btnResumeDraft").addEventListener("click", async () => {
    const draft = await store.loadDraft();
    if (draft?.file && draft?.meta && draft?.doc) openStudioWithProject(draft.file, draft.meta, draft.peaks, draft.doc);
  });
  $("btnDiscardDraft").addEventListener("click", async () => {
    await store.clearDraft();
    $("draftBanner").classList.remove("visible");
  });

  $("btnCancelProc").addEventListener("click", () => {
    clearInterval(procTimer);
    procAbort?.abort();
    store.set({ screen: "upload" });
  });

  $("btnNew").addEventListener("click", async () => {
    stopPlayback();
    await store.clearDraft();
    store.set({ screen: "upload", file: null, meta: null, error: null });
    $("draftBanner").classList.remove("visible");
    pushNavState("upload");
    refreshModelCacheUI();
  });
  $("btnUndo").addEventListener("click", () => store.undo());
  $("btnRedo").addEventListener("click", () => store.redo());
  $("btnBatch").addEventListener("click", () => {
    stopPlayback();
    store.set({ screen: "batch" });
    pushNavState("batch");
    renderBatchList();
  });
  $("btnBatchBack").addEventListener("click", () => {
    const st = store.get();
    store.set({ screen: st.file ? "studio" : "upload" });
  });

  // Stage Controls
  $("quickAspect").addEventListener("change", (e) => {
    store.updateDoc((d) => { d.frame.aspect = e.target.value; });
    syncCanvasDimensions();
    drawPreviewFrame(true);
  });

  $("safeZoneSel").addEventListener("change", (e) => {
    safeZoneMode = e.target.value;
    drawPreviewFrame(true);
  });

  $("btnToggleTransparentPreview").addEventListener("click", () => {
    const st = store.get();
    const isTrans = st.doc.frame.bgMode === "transparent";
    store.updateDoc((d) => {
      d.frame.bgMode = isTrans ? (st.meta?.isAudioOnly ? "waveform" : "video") : "transparent";
    });
  });

  $("btnImportSrt").addEventListener("click", () => $("srtImportInput").click());
  $("srtImportInput").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const text = await f.text();
    const rawWords = parseSubtitles(text);
    if (!rawWords.length) return alert("No valid subtitle cues found.");
    const st = store.get();
    const words = normalizeWords(rawWords, st.meta?.duration || Infinity);
    store.updateDoc((d) => { d.pages = segmentWords(words, { wordsPerPage: d.style.wordsPerPage }); });
    renderInspector();
    drawPreviewFrame(true);
  });

  // Playback & Loop
  $("btnPlayPause").addEventListener("click", togglePlayback);
  $("btnLoop").addEventListener("click", () => {
    isLooping = !isLooping;
    $("hiddenVideo").loop = isLooping;
    $("hiddenAudio").loop = isLooping;
    $("btnLoop").classList.toggle("btn-primary", isLooping);
    $("btnLoop").classList.toggle("btn-ghost", !isLooping);
    $("btnLoop").title = isLooping ? "Loop Video (ON)" : "Loop Video (Off)";
  });

  $("scrubber").addEventListener("input", (e) => {
    const tOut = parseFloat(e.target.value) || 0;
    const st = store.get();
    const cuts = cutsFor(st.doc, st.meta?.duration || 0);
    seekMedia(toSourceTime(cuts, tOut));
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.set({ activeTab: btn.dataset.tab });
      renderInspector();
    });
  });

  window.addEventListener("keydown", (e) => {
    if (store.get().screen !== "studio") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlayback(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      store.redo();
    }
  });

  // Export Modal
  $("btnExportOpen").addEventListener("click", () => {
    stopPlayback();
    const st = store.get();
    if (st.meta) {
      const origResOpt = $("expRes").querySelector('option[value="0"]');
      if (origResOpt) {
        origResOpt.textContent = st.meta.isAudioOnly
          ? "Original (1080×1920)"
          : `Original (${st.meta.width}×${st.meta.height})`;
      }
      const origFpsOpt = $("expFps").querySelector('option[value="0"]');
      if (origFpsOpt) origFpsOpt.textContent = `Original (${Math.round(st.meta.fps || 30)} fps)`;
    }
    $("exportError").classList.remove("visible");
    $("expDoneBox").classList.remove("visible");
    $("expProgressBox").style.display = "none";
    $("exportModal").classList.add("open");
    pushNavState("export");
    updateExportCapabilityNote();
  });
  $("btnExportClose").addEventListener("click", () => {
    if (expAbort) return;
    $("exportModal").classList.remove("open");
  });
  $("exportPresets").querySelectorAll(".export-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      selectedExportMode = opt.dataset.mode;
      $("exportPresets").querySelectorAll(".export-option").forEach((b) => b.classList.toggle("active", b === opt));
      updateExportCapabilityNote();
    });
  });
  $("btnExportStart").addEventListener("click", runExport);
  $("btnExportCancel").addEventListener("click", () => expAbort?.abort());

  $("btnDlSrt").addEventListener("click", exportSrtNow);
  $("btnDlVtt").addEventListener("click", () => dlSub("vtt", "text/vtt;charset=utf-8", toVtt(store.get().doc.pages, store.get().doc.offset, cutsFor(store.get().doc, store.get().meta.duration))));
  $("btnDlAss").addEventListener("click", () => dlSub("ass", "text/plain;charset=utf-8", toAss(store.get().doc.pages, store.get().doc.style, store.get().doc.offset, cutsFor(store.get().doc, store.get().meta.duration))));
  $("btnDlTxt").addEventListener("click", () => dlSub("txt", "text/plain;charset=utf-8", toPlainText(store.get().doc.pages)));

  $("btnBatchAdd").addEventListener("click", () => $("batchFilesInput").click());
  $("batchFilesInput").addEventListener("change", (e) => {
    for (const f of e.target.files || []) batchQueue.push(createBatchItem(f));
    e.target.value = "";
    renderBatchList();
  });
  $("btnBatchRun").addEventListener("click", runBatchQueue);
}

function dlSub(ext, mime, content) {
  const stem = (store.get().meta?.name || "captions").replace(/\.[^.]+$/, "");
  downloadBlob(new Blob([content], { type: mime }), `${stem}.${ext}`);
}

function exportSrtNow() {
  const st = store.get();
  if (!st.meta) return;
  dlSub("srt", "text/plain;charset=utf-8", toSrt(st.doc.pages, st.doc.offset, cutsFor(st.doc, st.meta.duration)));
}

/* ==========================================================================
   Media Workflow (Live 1s Elapsed Ticker + Smooth Progress)
   ========================================================================== */
async function startMediaWorkflow(file) {
  $("uploadError").classList.remove("visible");
  procAbort = new AbortController();
  const signal = procAbort.signal;
  const startedAt = performance.now();

  store.set({ screen: "processing", error: null });
  $("telFile").textContent = file.name;
  $("telDownload").textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  $("procTelemetryGrid").style.display = store.get().showLiveTelemetry ? "grid" : "none";

  // Keep elapsed clock & subtle activity alive every second so WASM inference never looks frozen!
  let currentPct = 2;
  let isTranscribingWasm = false;
  clearInterval(procTimer);
  procTimer = setInterval(() => {
    $("telElapsed").textContent = formatTime((performance.now() - startedAt) / 1000);
    if (isTranscribingWasm && currentPct < 94) {
      currentPct = Math.min(94, currentPct + 0.6);
      $("procPct").textContent = `${currentPct.toFixed(1)}%`;
      $("procBar").style.width = `${currentPct}%`;
    }
  }, 1000);

  const setProc = (stage, title, ratio, detail) => {
    const pct = Math.max(0, Math.min(100, ratio * 100));
    currentPct = Math.max(currentPct, pct);
    $("procStageText").textContent = stage;
    $("procTitle").textContent = title;
    $("procPct").textContent = `${pct.toFixed(1)}%`;
    $("procBar").style.width = `${Math.max(3, pct)}%`;
    $("procDetail").textContent = detail;
    $("telElapsed").textContent = formatTime((performance.now() - startedAt) / 1000);
  };

  try {
    setProc("Step 1 / 3", "Inspecting media…", 0.05, "Reading streams locally…");
    const meta = await probeMedia(file);
    signal.throwIfAborted();

    if (!meta.hasAudio) {
      clearInterval(procTimer);
      openStudioWithProject(file, meta, new Float32Array(0), createEmptyDoc(false));
      return;
    }

    setProc("Step 2 / 3", "Extracting audio…", 0.1, `Decoding ${formatTime(meta.duration)}…`);
    const { samples, peaks, duration } = await extractAudio(
      file,
      (r) => setProc("Step 2 / 3", "Extracting audio…", r, `Decoded ${(r * 100).toFixed(0)}%`),
      signal
    );
    if (!meta.duration && duration) meta.duration = duration;
    signal.throwIfAborted();

    const modelId = $("selModel").value;
    const modelInfo = getModelInfo(modelId);
    const language = $("selLanguage").value;
    currentPct = 2;
    setProc("Step 3 / 3", `Loading ${modelInfo.name}…`, 0.02, `Checking cache (${modelInfo.size})…`);

    const { words: rawWords, language: detected } = await transcribeAudio(samples, {
      model: modelId,
      language,
      signal,
      onLanguage: (lang) => { $("telStatus").textContent = `Lang: ${lang.toUpperCase()}`; },
      onProgress: (stage, ratio, info) => {
        if (stage === "model") {
          isTranscribingWasm = false;
          const tot = info?.totalMB > 0 ? info.totalMB : modelInfo.sizeMB;
          const loaded = info?.loadedMB || 0;
          const spd = info?.speedMBps > 0.05 ? ` • ${info.speedMBps.toFixed(1)} MB/s` : "";
          $("telDownload").textContent = info?.cached ? "Cached ✓" : `${loaded.toFixed(1)}/${tot.toFixed(0)} MB`;
          setProc(
            "Downloading AI",
            `Caching ${modelInfo.name}…`,
            ratio,
            info?.cached ? "Loaded from local cache ✓" : `${loaded.toFixed(1)} MB of ${tot.toFixed(1)} MB${spd}`
          );
        } else {
          isTranscribingWasm = true;
          $("telDownload").textContent = `${formatTime(meta.duration)}`;
          const chunkMsg = info?.totalChunks ? `Transcribing chunk ${info.chunk} of ${info.totalChunks} (local CPU)…` : "Transcribing speech…";
          setProc("Transcribing", "Generating captions…", Math.max(ratio, currentPct / 100), chunkMsg);
        }
      },
    });
    signal.throwIfAborted();

    clearInterval(procTimer);
    refreshModelCacheUI();
    const normalized = tightenWords(normalizeWords(rawWords.map((w) => ({ id: uid("w"), ...w })), meta.duration), peaks);
    const doc = createEmptyDoc(meta.isAudioOnly);
    doc.pages = segmentWords(normalized, { wordsPerPage: doc.style.wordsPerPage });

    store.set({ detectedLanguage: detected });
    openStudioWithProject(file, meta, peaks, doc);
  } catch (err) {
    clearInterval(procTimer);
    if (err?.name === "AbortError") return;
    store.set({ screen: "upload" });
    $("uploadError").textContent = err instanceof Error ? err.message : String(err);
    $("uploadError").classList.add("visible");
  }
}

/* ==========================================================================
   Studio & Ultra-Smooth 60fps Canvas Preview
   ========================================================================== */
async function openStudioWithProject(file, meta, peaks, doc) {
  const prevUrl = store.get().mediaUrl;
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  const mediaUrl = URL.createObjectURL(file);

  const videoEl = $("hiddenVideo");
  const audioEl = $("hiddenAudio");
  videoEl.pause(); audioEl.pause();
  videoEl.removeAttribute("src"); audioEl.removeAttribute("src");
  videoEl.loop = isLooping;
  audioEl.loop = isLooping;

  if (meta.isAudioOnly) {
    audioEl.src = mediaUrl;
    audioEl.load();
  } else {
    videoEl.src = mediaUrl;
    videoEl.load();
  }

  store.set({
    screen: "studio",
    file,
    mediaUrl,
    meta,
    peaks: peaks || new Float32Array(0),
    doc,
    past: [],
    future: [],
    currentTime: 0,
    playing: false,
  });
  pushNavState("studio");
  store.scheduleDraftSave();

  await ensureFont(doc.style.font, doc.style.weight, doc.style.italic, glyphsOf(doc.pages));
  syncCanvasDimensions();
  renderInspector();

  const activeEl = getMediaEl();
  activeEl.onloadeddata = () => drawPreviewFrame(true);
  activeEl.onseeked = () => drawPreviewFrame(true);
  activeEl.onended = () => {
    if (!isLooping) {
      store.set({ playing: false });
      $("btnPlayPause").innerHTML = ICON_PLAY;
    }
  };
  drawPreviewFrame(true);
}

function getMediaEl() {
  return store.get().meta?.isAudioOnly ? $("hiddenAudio") : $("hiddenVideo");
}

function syncCanvasDimensions() {
  const st = store.get();
  if (!st.meta) return;
  const canvas = $("previewCanvas");
  // Cap live preview short side to 480px on mobile / 540px on desktop for silky 60fps (Export uses full native resolution!)
  const previewShort = window.innerWidth < 860 ? 480 : 540;
  const { width, height } = frameSize(st.meta, st.doc.frame.aspect, previewShort);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    previewCtx = canvas.getContext("2d", { alpha: true });
  }
  if (!previewCtx) previewCtx = canvas.getContext("2d", { alpha: true });
  canvas.classList.toggle("alpha-grid", st.doc.frame.bgMode === "transparent");
}

function drawPreviewFrame(forceUi = false) {
  const st = store.get();
  if (st.screen !== "studio" || !st.meta) return;
  if (!previewCtx) syncCanvasDimensions();

  const canvas = $("previewCanvas");
  const mediaEl = getMediaEl();
  const tSrc = mediaEl.currentTime || 0;
  const cuts = cutsFor(st.doc, st.meta.duration);
  const outDur = Math.max(0.1, st.meta.duration - cutTotal(cuts, st.meta.duration));
  const tOut = toOutputTime(cuts, tSrc);

  const srcObj = !st.meta.isAudioOnly && mediaEl.readyState >= 2
    ? {
        width: mediaEl.videoWidth || st.meta.width,
        height: mediaEl.videoHeight || st.meta.height,
        draw: (c, sx, sy, sw, sh, dx, dy, dw, dh) => c.drawImage(mediaEl, sx, sy, sw, sh, dx, dy, dw, dh),
      }
    : null;

  renderScene(previewCtx, srcObj, canvas.width, canvas.height, tSrc, tOut, outDur, st.doc, {
    peaks: st.peaks,
    safeZone: safeZoneMode,
  });

  // Throttle scrubber & text DOM updates during playback so mobile stays 60fps
  const now = performance.now();
  if (forceUi || now - lastUiTick > 85) {
    lastUiTick = now;
    $("timeCur").textContent = formatTime(tOut);
    $("timeDur").textContent = formatTime(outDur);
    $("scrubber").max = outDur.toFixed(2);
    $("scrubber").value = tOut.toFixed(2);
  }
}

function togglePlayback() {
  const el = getMediaEl();
  if (el.paused) {
    el.play().then(() => {
      store.set({ playing: true });
      $("btnPlayPause").innerHTML = ICON_PAUSE;
      tickPlayback();
    }).catch(() => {});
  } else {
    stopPlayback();
  }
}

function stopPlayback() {
  cancelAnimationFrame(rafId);
  $("hiddenVideo").pause();
  $("hiddenAudio").pause();
  store.set({ playing: false });
  $("btnPlayPause").innerHTML = ICON_PLAY;
}

function seekMedia(tSrc) {
  const el = getMediaEl();
  el.currentTime = Math.max(0, Math.min(store.get().meta?.duration || 0, tSrc));
  drawPreviewFrame(true);
}

function tickPlayback() {
  const st = store.get();
  if (!st.playing) return;
  const el = getMediaEl();
  const cuts = cutsFor(st.doc, st.meta.duration);
  const jump = skipTarget(cuts, el.currentTime);
  if (jump !== null) el.currentTime = jump;
  drawPreviewFrame(false);
  rafId = requestAnimationFrame(tickPlayback);
}

/* ==========================================================================
   State Sync & Inspector
   ========================================================================== */
function onStateChange(st) {
  $("screenUpload").classList.toggle("active", st.screen === "upload");
  $("screenProcessing").classList.toggle("active", st.screen === "processing");
  $("screenStudio").classList.toggle("active", st.screen === "studio");
  $("screenBatch").classList.toggle("active", st.screen === "batch");

  const inStudio = st.screen === "studio";
  $("btnUndo").style.display = inStudio ? "inline-flex" : "none";
  $("btnRedo").style.display = inStudio ? "inline-flex" : "none";
  $("btnNew").style.display = inStudio ? "inline-flex" : "none";
  $("btnExportOpen").style.display = inStudio ? "inline-flex" : "none";
  $("btnUndo").disabled = !st.past.length;
  $("btnRedo").disabled = !st.future.length;

  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === st.activeTab));

  if (inStudio && st.meta) {
    $("mediaBadgeText").textContent = st.meta.isAudioOnly
      ? `Audio • ${formatTime(st.meta.duration)}`
      : `${st.meta.width}×${st.meta.height}`;
    $("quickAspect").value = st.doc.frame.aspect;
    const isTrans = st.doc.frame.bgMode === "transparent";
    $("btnToggleTransparentPreview").textContent = isTrans ? "Alpha: ON" : "Alpha: OFF";
    $("btnToggleTransparentPreview").classList.toggle("btn-primary", isTrans);
    $("btnToggleTransparentPreview").classList.toggle("btn-secondary", !isTrans);
    syncCanvasDimensions();
    drawPreviewFrame(true);
  }
}

function renderInspector() {
  const st = store.get();
  const body = $("inspectorBody");
  body.innerHTML = "";
  if (st.activeTab === "styles") renderStylesTab(body, st);
  else if (st.activeTab === "customize") renderCustomizeTab(body, st);
  else if (st.activeTab === "transcript") renderTranscriptTab(body, st);
  else if (st.activeTab === "effects") renderEffectsTab(body, st);
  else if (st.activeTab === "frame") renderFrameTab(body, st);
}

/* --- TAB 1: STYLES + SAVED USER PRESETS --- */
function renderStylesTab(container, st) {
  // Saved User Presets Bar
  const presetBar = document.createElement("div");
  presetBar.className = "preset-bar";
  presetBar.innerHTML = `
    <div class="control-row">
      <span class="section-title">Saved Presets</span>
      <button id="btnSavePreset" class="btn btn-primary btn-sm" style="height:26px;font-size:11.5px;">+ Save Current</button>
    </div>
    <div id="userPresetChips" class="preset-chips"></div>
  `;
  container.appendChild(presetBar);

  const chipsWrap = presetBar.querySelector("#userPresetChips");
  if (!userPresets.length) {
    chipsWrap.innerHTML = `<span style="font-size:11.5px;color:var(--faint);">Save your favorite font, colors &amp; effects to reuse anytime.</span>`;
  } else {
    userPresets.forEach((p, idx) => {
      const chip = document.createElement("span");
      chip.className = "preset-chip";
      chip.innerHTML = `<button class="p-apply" style="font-weight:700;">${p.name}</button><button class="p-del" style="color:var(--faint);font-size:11px;" title="Delete">✕</button>`;
      chip.querySelector(".p-apply").onclick = async () => {
        const nextStyle = structuredClone(p.style);
        await ensureFont(nextStyle.font, nextStyle.weight, nextStyle.italic, glyphsOf(st.doc.pages));
        store.updateDoc((d) => {
          d.templateId = p.templateId || d.templateId;
          d.style = nextStyle;
          if (p.fx) d.fx = structuredClone(p.fx);
          if (d.pages.length) d.pages = resegment(d.pages, { wordsPerPage: nextStyle.wordsPerPage });
        });
        renderInspector();
      };
      chip.querySelector(".p-del").onclick = async () => {
        userPresets.splice(idx, 1);
        await idbSet(USER_PRESETS_KEY, userPresets);
        renderInspector();
      };
      chipsWrap.appendChild(chip);
    });
  }

  presetBar.querySelector("#btnSavePreset").onclick = async () => {
    const name = window.prompt("Name this preset (e.g. BIMWOB Shorts):");
    if (!name || !name.trim()) return;
    userPresets.push({
      id: uid("up"),
      name: name.trim().slice(0, 28),
      templateId: st.doc.templateId,
      style: structuredClone(st.doc.style),
      fx: structuredClone(st.doc.fx),
    });
    await idbSet(USER_PRESETS_KEY, userPresets);
    renderInspector();
  };

  const filterRow = document.createElement("div");
  filterRow.className = "filter-pills";
  for (const [key, label] of [["all", "All (28)"], ["viral", "★ Viral (10)"], ["classic", "Classic (18)"]]) {
    const b = document.createElement("button");
    b.className = `filter-pill ${st.styleFilter === key ? "active" : ""}`;
    b.textContent = label;
    b.onclick = () => { store.set({ styleFilter: key }); renderInspector(); };
    filterRow.appendChild(b);
  }
  container.appendChild(filterRow);

  const grid = document.createElement("div");
  grid.className = "styles-grid";
  const list = TEMPLATES.filter((t) => st.styleFilter === "all" || t.category === st.styleFilter);

  for (const tpl of list) {
    const card = document.createElement("button");
    card.className = `style-card ${st.doc.templateId === tpl.id ? "active" : ""}`;
    const previewColor = tpl.style.activeColor || tpl.style.gradient?.[0] || tpl.style.color;
    const previewBg = tpl.style.box?.color || tpl.style.activeBox?.color || "linear-gradient(135deg,#0b162c,#1e3a8a)";
    card.innerHTML = `
      <div class="style-preview" style="font-family:'${tpl.style.font}',sans-serif;font-weight:${tpl.style.weight};font-style:${tpl.style.italic ? "italic" : "normal"};color:${previewColor};background:${previewBg};text-transform:${tpl.style.textCase === "upper" ? "uppercase" : tpl.style.textCase === "lower" ? "lowercase" : "none"};">
        <span>VIRAL</span>
      </div>
      <div class="style-meta">
        <span class="style-name">${tpl.name}</span>
        ${tpl.category === "viral" ? '<span class="viral-tag">Viral</span>' : ""}
      </div>
    `;
    card.onclick = async () => {
      const nextStyle = structuredClone(tpl.style);
      await ensureFont(nextStyle.font, nextStyle.weight, nextStyle.italic, glyphsOf(st.doc.pages));
      store.updateDoc((d) => {
        const wppChanged = d.style.wordsPerPage !== nextStyle.wordsPerPage;
        d.templateId = tpl.id;
        d.style = nextStyle;
        if (wppChanged && d.pages.length) d.pages = resegment(d.pages, { wordsPerPage: nextStyle.wordsPerPage });
      });
      renderInspector();
    };
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

/* --- TAB 2: CUSTOMIZE WITH PER-SETTING RESET (↺) --- */
function renderCustomizeTab(container, st) {
  const s = st.doc.style;
  const base = getTemplate(st.doc.templateId).style;
  const fonts = getFontNames();
  const weights = weightsFor(s.font);

  const resetBtn = (key) => `<button class="reset-mini" data-reset="${key}" title="Reset to template default">${ICON_RESET}</button>`;

  const card1 = document.createElement("div");
  card1.className = "section-card";
  card1.innerHTML = `
    <div class="section-head">
      <span class="section-title">Typography</span>
      <button id="btnResetAllStyle" class="btn btn-ghost btn-sm" style="height:24px;font-size:11px;">Reset All</button>
    </div>
    <div class="control-grid-2">
      <div>
        <div class="range-head"><label class="field-label" style="margin:0;">Font</label>${resetBtn("font")}</div>
        <select id="cFont" class="select">${fonts.map((f) => `<option value="${f}" ${f === s.font ? "selected" : ""}>${f}</option>`).join("")}</select>
      </div>
      <div>
        <div class="range-head"><label class="field-label" style="margin:0;">Weight</label>${resetBtn("weight")}</div>
        <select id="cWeight" class="select">${weights.map((w) => `<option value="${w}" ${w === s.weight ? "selected" : ""}>${w}</option>`).join("")}</select>
      </div>
    </div>
    <div class="control-grid-2">
      <div>
        <div class="range-head"><label class="field-label" style="margin:0;">Case</label>${resetBtn("textCase")}</div>
        <select id="cCase" class="select">
          <option value="upper" ${s.textCase === "upper" ? "selected" : ""}>UPPER</option>
          <option value="none" ${s.textCase === "none" ? "selected" : ""}>Normal</option>
          <option value="lower" ${s.textCase === "lower" ? "selected" : ""}>lower</option>
        </select>
      </div>
      <div>
        <div class="range-head"><label class="field-label" style="margin:0;">Motion</label>${resetBtn("entrance")}</div>
        <select id="cEntrance" class="select">
          ${["none", "pop", "fade", "rise", "drop", "zoom", "slide"].map((e) => `<option value="${e}" ${e === s.entrance ? "selected" : ""}>${e.toUpperCase()}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Font Size</span><span class="range-right"><strong id="vSize">${s.size.toFixed(1)}%</strong>${resetBtn("size")}</span></div>
      <input id="cSize" type="range" min="3" max="15" step="0.2" value="${s.size}" />
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Vertical Position (Y)</span><span class="range-right"><strong id="vY">${Math.round(s.y * 100)}%</strong>${resetBtn("y")}</span></div>
      <input id="cY" type="range" min="12" max="92" step="1" value="${Math.round(s.y * 100)}" />
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Words Per Caption</span><span class="range-right"><strong id="vWpp">${s.wordsPerPage}</strong>${resetBtn("wordsPerPage")}</span></div>
      <input id="cWpp" type="range" min="1" max="8" step="1" value="${s.wordsPerPage}" />
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Active Pop Scale</span><span class="range-right"><strong id="vScale">${s.activeScale.toFixed(2)}x</strong>${resetBtn("activeScale")}</span></div>
      <input id="cScale" type="range" min="1" max="1.3" step="0.02" value="${s.activeScale}" />
    </div>
    <label class="toggle-row"><span>Punctuation</span><input id="cPunct" type="checkbox" class="switch" ${s.punctuation ? "checked" : ""} /></label>
    <label class="toggle-row"><span>Italic</span><input id="cItalic" type="checkbox" class="switch" ${s.italic ? "checked" : ""} /></label>
  `;
  container.appendChild(card1);

  const card2 = document.createElement("div");
  card2.className = "section-card";
  card2.innerHTML = `
    <div class="section-title">Colors &amp; Outline</div>
    <div class="control-row">
      <span style="font-size:12.5px;">Text Color</span>
      <span class="range-right"><input id="cColor" type="color" value="${s.color || "#FFFFFF"}" />${resetBtn("color")}</span>
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Active Word</span>
      <span class="range-right">
        <input id="cActiveColor" type="color" value="${s.activeColor || "#FFE600"}" />
        <input id="cActiveOn" type="checkbox" class="switch" ${s.activeColor ? "checked" : ""} />
        ${resetBtn("activeColor")}
      </span>
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Outline Stroke</span>
      <span class="range-right">
        <input id="cStrokeColor" type="color" value="${s.stroke?.color || "#000000"}" />
        <input id="cStrokeOn" type="checkbox" class="switch" ${s.stroke ? "checked" : ""} />
        ${resetBtn("stroke")}
      </span>
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Stroke Width</span><strong id="vStroke">${((s.stroke?.width || 0.1) * 100).toFixed(0)}</strong></div>
      <input id="cStrokeW" type="range" min="2" max="22" step="1" value="${Math.round((s.stroke?.width || 0.1) * 100)}" />
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Active Word Pill</span>
      <span class="range-right">
        <input id="cPillColor" type="color" value="${s.activeBox?.color || "#2563EB"}" />
        <input id="cPillOn" type="checkbox" class="switch" ${s.activeBox ? "checked" : ""} />
        ${resetBtn("activeBox")}
      </span>
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Background Box</span>
      <span class="range-right">
        <select id="cBoxScope" class="select" style="width:auto;padding:4px 8px;">
          <option value="none" ${!s.box ? "selected" : ""}>None</option>
          <option value="line" ${s.box?.scope === "line" ? "selected" : ""}>Per Line</option>
          <option value="page" ${s.box?.scope === "page" ? "selected" : ""}>Full Block</option>
        </select>
        ${resetBtn("box")}
      </span>
    </div>
  `;
  container.appendChild(card2);

  // Per-setting Reset handlers
  container.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.onclick = async () => {
      const k = btn.dataset.reset;
      const val = structuredClone(base[k]);
      if (k === "font" || k === "weight") {
        await ensureFont(k === "font" ? val : s.font, k === "weight" ? val : base.weight, s.italic, glyphsOf(st.doc.pages));
      }
      store.updateDoc((d) => {
        d.style[k] = val;
        if (k === "font") d.style.weight = base.weight;
        if (k === "color") d.style.gradient = structuredClone(base.gradient);
        if (k === "wordsPerPage" && d.pages.length) d.pages = resegment(d.pages, { wordsPerPage: val });
      });
      renderInspector();
    };
  });

  card1.querySelector("#btnResetAllStyle").onclick = async () => {
    const next = structuredClone(base);
    await ensureFont(next.font, next.weight, next.italic, glyphsOf(st.doc.pages));
    store.updateDoc((d) => {
      d.style = next;
      if (d.pages.length) d.pages = resegment(d.pages, { wordsPerPage: next.wordsPerPage });
    });
    renderInspector();
  };

  card1.querySelector("#cFont").onchange = async (e) => {
    const font = e.target.value;
    const w = weightsFor(font)[0] || 700;
    await ensureFont(font, w, s.italic, glyphsOf(st.doc.pages));
    store.updateDoc((d) => { d.style.font = font; d.style.weight = w; });
    renderInspector();
  };
  card1.querySelector("#cWeight").onchange = async (e) => {
    const w = parseInt(e.target.value, 10);
    await ensureFont(s.font, w, s.italic, glyphsOf(st.doc.pages));
    store.updateDoc((d) => { d.style.weight = w; });
  };
  card1.querySelector("#cCase").onchange = (e) => store.updateDoc((d) => { d.style.textCase = e.target.value; });
  card1.querySelector("#cEntrance").onchange = (e) => store.updateDoc((d) => { d.style.entrance = e.target.value; });
  card1.querySelector("#cSize").oninput = (e) => {
    const v = parseFloat(e.target.value);
    card1.querySelector("#vSize").textContent = `${v.toFixed(1)}%`;
    store.updateDoc((d) => { d.style.size = v; }, false);
  };
  card1.querySelector("#cY").oninput = (e) => {
    const v = parseInt(e.target.value, 10);
    card1.querySelector("#vY").textContent = `${v}%`;
    store.updateDoc((d) => { d.style.y = v / 100; }, false);
  };
  card1.querySelector("#cWpp").onchange = (e) => {
    const v = parseInt(e.target.value, 10);
    card1.querySelector("#vWpp").textContent = String(v);
    store.updateDoc((d) => {
      d.style.wordsPerPage = v;
      if (d.pages.length) d.pages = resegment(d.pages, { wordsPerPage: v });
    });
  };
  card1.querySelector("#cScale").oninput = (e) => {
    const v = parseFloat(e.target.value);
    card1.querySelector("#vScale").textContent = `${v.toFixed(2)}x`;
    store.updateDoc((d) => { d.style.activeScale = v; }, false);
  };
  card1.querySelector("#cPunct").onchange = (e) => store.updateDoc((d) => { d.style.punctuation = e.target.checked; });
  card1.querySelector("#cItalic").onchange = async (e) => {
    await ensureFont(s.font, s.weight, e.target.checked, glyphsOf(st.doc.pages));
    store.updateDoc((d) => { d.style.italic = e.target.checked; });
  };

  card2.querySelector("#cColor").oninput = (e) => store.updateDoc((d) => { d.style.color = e.target.value; d.style.gradient = null; }, false);
  card2.querySelector("#cActiveColor").oninput = (e) => {
    card2.querySelector("#cActiveOn").checked = true;
    store.updateDoc((d) => { d.style.activeColor = e.target.value; }, false);
  };
  card2.querySelector("#cActiveOn").onchange = (e) => store.updateDoc((d) => { d.style.activeColor = e.target.checked ? card2.querySelector("#cActiveColor").value : null; });
  card2.querySelector("#cStrokeColor").oninput = (e) => {
    card2.querySelector("#cStrokeOn").checked = true;
    store.updateDoc((d) => { d.style.stroke = { color: e.target.value, width: d.style.stroke?.width ?? 0.1 }; }, false);
  };
  card2.querySelector("#cStrokeOn").onchange = (e) => store.updateDoc((d) => { d.style.stroke = e.target.checked ? { color: card2.querySelector("#cStrokeColor").value, width: 0.1 } : null; });
  card2.querySelector("#cStrokeW").oninput = (e) => {
    const v = parseInt(e.target.value, 10);
    card2.querySelector("#vStroke").textContent = String(v);
    store.updateDoc((d) => {
      if (d.style.stroke) d.style.stroke.width = v / 100;
      else d.style.stroke = { color: card2.querySelector("#cStrokeColor").value, width: v / 100 };
    }, false);
  };
  card2.querySelector("#cPillColor").oninput = (e) => {
    card2.querySelector("#cPillOn").checked = true;
    store.updateDoc((d) => { d.style.activeBox = { color: e.target.value, radius: 0.24, padX: 0.2, padY: 0.06 }; }, false);
  };
  card2.querySelector("#cPillOn").onchange = (e) => store.updateDoc((d) => { d.style.activeBox = e.target.checked ? { color: card2.querySelector("#cPillColor").value, radius: 0.24, padX: 0.2, padY: 0.06 } : null; });
  card2.querySelector("#cBoxScope").onchange = (e) => {
    const v = e.target.value;
    store.updateDoc((d) => { d.style.box = v === "none" ? null : { color: "rgba(11,22,44,0.88)", radius: 0.26, padX: 0.45, padY: 0.2, scope: v }; });
  };
}

/* --- TAB 3: TRANSCRIPT + QUICK YOUTUBE .SRT EXPORT --- */
function renderTranscriptTab(container, st) {
  const bar = document.createElement("div");
  bar.className = "control-row";
  bar.innerHTML = `
    <span style="font-size:12px;color:var(--faint);">${st.doc.pages.length} captions</span>
    <button id="btnQuickSrt" class="btn btn-secondary btn-sm">Download YouTube .SRT</button>
  `;
  bar.querySelector("#btnQuickSrt").onclick = exportSrtNow;
  container.appendChild(bar);

  if (!st.doc.pages.length) {
    const empty = document.createElement("div");
    empty.className = "section-card";
    empty.innerHTML = `<p style="color:var(--muted);">No captions yet.</p><button id="btnAddFirstCap" class="btn btn-primary btn-sm">+ Add Caption</button>`;
    empty.querySelector("#btnAddFirstCap").onclick = () => {
      store.updateDoc((d) => {
        d.pages.push({ id: uid("p"), words: [{ id: uid("w"), text: "Hello", start: 0, end: 1 }, { id: uid("w"), text: "world!", start: 1, end: 2 }] });
      });
      renderInspector();
    };
    container.appendChild(empty);
    return;
  }

  st.doc.pages.forEach((page, idx) => {
    const card = document.createElement("div");
    card.className = "page-card";
    card.innerHTML = `
      <div class="page-head">
        <button class="btn-seek" style="color:var(--blue);font-weight:700;">${formatTime(pageStart(page))}</button>
        <div style="display:flex;gap:4px;">
          <input class="emoji-in" type="text" placeholder="Emoji" value="${page.emoji ?? ""}" style="width:44px;background:var(--subtle);border:1px solid var(--line);border-radius:6px;padding:2px 4px;text-align:center;font-size:12px;" />
          ${idx < st.doc.pages.length - 1 ? '<button class="btn btn-ghost btn-sm btn-join" style="height:26px;padding:0 6px;">Join</button>' : ""}
          <button class="btn btn-ghost btn-sm btn-del" style="height:26px;padding:0 6px;color:var(--err-ink);">✕</button>
        </div>
      </div>
      <input class="input page-input" type="text" value="${pageText(page).replace(/"/g, "&quot;")}" />
      <div class="word-chips">
        ${page.words.map((w, wi) => `<button class="word-chip ${w.emphasis ? "emphasis" : ""}" data-wi="${wi}">${w.text}</button>`).join("")}
      </div>
    `;
    card.querySelector(".btn-seek").onclick = () => seekMedia(pageStart(page));
    card.querySelector(".page-input").onchange = (e) => {
      store.updateDoc((d) => {
        const nextWords = retimeWords(d.pages[idx], e.target.value);
        if (nextWords.length) d.pages[idx].words = nextWords;
        else d.pages.splice(idx, 1);
      });
      renderInspector();
    };
    card.querySelector(".emoji-in").onchange = (e) => store.updateDoc((d) => { d.pages[idx].emoji = e.target.value.trim() || null; });
    card.querySelector(".btn-del").onclick = () => { store.updateDoc((d) => { d.pages.splice(idx, 1); }); renderInspector(); };
    const joinBtn = card.querySelector(".btn-join");
    if (joinBtn) {
      joinBtn.onclick = () => {
        store.updateDoc((d) => {
          d.pages[idx].words = [...d.pages[idx].words, ...d.pages[idx + 1].words];
          d.pages.splice(idx + 1, 1);
        });
        renderInspector();
      };
    }
    card.querySelectorAll(".word-chip").forEach((chip) => {
      chip.onclick = () => {
        const wi = parseInt(chip.dataset.wi, 10);
        store.updateDoc((d) => { d.pages[idx].words[wi].emphasis = !d.pages[idx].words[wi].emphasis; });
        renderInspector();
      };
    });
    container.appendChild(card);
  });
}

/* --- TAB 4: EFFECTS WITH RESET --- */
function renderEffectsTab(container, st) {
  const fx = st.doc.fx;
  container.innerHTML = `
    <div class="section-card">
      <div class="section-head">
        <span class="section-title">Sync Offset</span>
        <button id="rstOffset" class="reset-mini" title="Reset offset">${ICON_RESET}</button>
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Timing Nudge</span><strong id="vOffset">${(st.doc.offset >= 0 ? "+" : "") + st.doc.offset.toFixed(2)}s</strong></div>
        <input id="fxOffset" type="range" min="-2" max="2" step="0.05" value="${st.doc.offset}" />
      </div>
    </div>
    <div class="section-card">
      <div class="section-title">Auto Emoji &amp; Hook</div>
      <label class="toggle-row"><span>Auto Emoji</span><input id="fxEmoji" type="checkbox" class="switch" ${fx.emoji.enabled ? "checked" : ""} /></label>
      <label class="toggle-row"><span>Opening Hook Card</span><input id="fxHook" type="checkbox" class="switch" ${fx.hook.enabled ? "checked" : ""} /></label>
      <input id="fxHookText" class="input" type="text" placeholder="Hook title…" value="${fx.hook.text.replace(/"/g, "&quot;")}" />
    </div>
    <div class="section-card">
      <div class="section-title">Motion &amp; Cuts</div>
      <label class="toggle-row"><span>Progress Bar</span><input id="fxProg" type="checkbox" class="switch" ${fx.progress.enabled ? "checked" : ""} /></label>
      <label class="toggle-row"><span>Auto Dynamic Zoom</span><input id="fxZoom" type="checkbox" class="switch" ${fx.zoom.enabled ? "checked" : ""} /></label>
      <label class="toggle-row"><span>Silence Jump Cuts</span><input id="fxCuts" type="checkbox" class="switch" ${fx.cuts.enabled ? "checked" : ""} /></label>
      <select id="fxPace" class="select">
        <option value="natural" ${fx.cuts.pace === "natural" ? "selected" : ""}>Pace: Natural</option>
        <option value="fast" ${fx.cuts.pace === "fast" ? "selected" : ""}>Pace: Fast</option>
        <option value="extra" ${fx.cuts.pace === "extra" ? "selected" : ""}>Pace: Extra Tight</option>
      </select>
    </div>
  `;
  container.querySelector("#rstOffset").onclick = () => { store.updateDoc((d) => { d.offset = 0; }); renderInspector(); };
  container.querySelector("#fxOffset").oninput = (e) => {
    const v = parseFloat(e.target.value);
    container.querySelector("#vOffset").textContent = `${v >= 0 ? "+" : ""}${v.toFixed(2)}s`;
    store.updateDoc((d) => { d.offset = v; }, false);
  };
  container.querySelector("#fxEmoji").onchange = (e) => store.updateDoc((d) => { d.fx.emoji.enabled = e.target.checked; });
  container.querySelector("#fxHook").onchange = (e) => store.updateDoc((d) => { d.fx.hook.enabled = e.target.checked; });
  container.querySelector("#fxHookText").oninput = (e) => store.updateDoc((d) => { d.fx.hook.text = e.target.value; }, false);
  container.querySelector("#fxProg").onchange = (e) => store.updateDoc((d) => { d.fx.progress.enabled = e.target.checked; });
  container.querySelector("#fxZoom").onchange = (e) => store.updateDoc((d) => { d.fx.zoom.enabled = e.target.checked; });
  container.querySelector("#fxCuts").onchange = (e) => store.updateDoc((d) => { d.fx.cuts.enabled = e.target.checked; });
  container.querySelector("#fxPace").onchange = (e) => store.updateDoc((d) => { d.fx.cuts.pace = e.target.value; });
}

/* --- TAB 5: FRAME, WORKING PAN X/Y & ZOOM + RESET --- */
function renderFrameTab(container, st) {
  const f = st.doc.frame;
  const scaleVal = f.scale || 1;
  container.innerHTML = `
    <div class="section-card">
      <div class="section-title">Background Mode</div>
      <select id="frBgMode" class="select">
        ${!st.meta?.isAudioOnly ? `<option value="video" ${f.bgMode === "video" ? "selected" : ""}>Original Video</option>` : ""}
        <option value="transparent" ${f.bgMode === "transparent" ? "selected" : ""}>Transparent Alpha</option>
        <option value="chroma-green" ${f.bgMode === "chroma-green" ? "selected" : ""}>Chroma Green (#00FF00)</option>
        <option value="chroma-blue" ${f.bgMode === "chroma-blue" ? "selected" : ""}>Chroma Blue (#0000FF)</option>
        <option value="waveform" ${f.bgMode === "waveform" ? "selected" : ""}>Audio Waveform</option>
        <option value="gradient" ${f.bgMode === "gradient" ? "selected" : ""}>Navy Gradient</option>
        <option value="solid" ${f.bgMode === "solid" ? "selected" : ""}>Solid Color</option>
      </select>
      <div class="control-grid-2">
        <div class="control-row"><span style="font-size:12px;">Color 1</span><input id="frBg1" type="color" value="${f.bgColor}" /></div>
        <div class="control-row"><span style="font-size:12px;">Color 2</span><input id="frBg2" type="color" value="${f.bgColor2}" /></div>
      </div>
    </div>
    <div class="section-card">
      <div class="section-head">
        <span class="section-title">Reframe, Pan &amp; Zoom</span>
        <button id="rstFrame" class="btn btn-ghost btn-sm" style="height:24px;font-size:11px;">Reset</button>
      </div>
      <div class="control-grid-2">
        <div>
          <label class="field-label">Aspect</label>
          <select id="frAspect" class="select">
            <option value="source" ${f.aspect === "source" ? "selected" : ""}>Original</option>
            <option value="9:16" ${f.aspect === "9:16" ? "selected" : ""}>9:16</option>
            <option value="4:5" ${f.aspect === "4:5" ? "selected" : ""}>4:5</option>
            <option value="1:1" ${f.aspect === "1:1" ? "selected" : ""}>1:1</option>
            <option value="16:9" ${f.aspect === "16:9" ? "selected" : ""}>16:9</option>
          </select>
        </div>
        <div>
          <label class="field-label">Fit</label>
          <select id="frFit" class="select">
            <option value="cover" ${f.fit === "cover" ? "selected" : ""}>Crop Fill</option>
            <option value="blur" ${f.fit === "blur" ? "selected" : ""}>Blur BG</option>
            <option value="contain" ${f.fit === "contain" ? "selected" : ""}>Fit Inside</option>
          </select>
        </div>
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Zoom Scale</span><span class="range-right"><strong id="vFrScale">${Math.round(scaleVal * 100)}%</strong><button class="reset-mini" id="rstScale">${ICON_RESET}</button></span></div>
        <input id="frScale" type="range" min="0.6" max="2.2" step="0.05" value="${scaleVal}" />
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Horizontal Pan</span><span class="range-right"><strong id="vPanX">${Math.round((f.panX || 0) * 100)}%</strong><button class="reset-mini" id="rstPanX">${ICON_RESET}</button></span></div>
        <input id="frPanX" type="range" min="-1" max="1" step="0.02" value="${f.panX || 0}" />
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Vertical Pan</span><span class="range-right"><strong id="vPanY">${Math.round((f.panY || 0) * 100)}%</strong><button class="reset-mini" id="rstPanY">${ICON_RESET}</button></span></div>
        <input id="frPanY" type="range" min="-1" max="1" step="0.02" value="${f.panY || 0}" />
      </div>
    </div>
  `;
  container.querySelector("#rstFrame").onclick = () => {
    store.updateDoc((d) => { d.frame.panX = 0; d.frame.panY = 0; d.frame.scale = 1; d.frame.fit = "cover"; });
    renderInspector();
  };
  container.querySelector("#rstScale").onclick = () => { store.updateDoc((d) => { d.frame.scale = 1; }); renderInspector(); };
  container.querySelector("#rstPanX").onclick = () => { store.updateDoc((d) => { d.frame.panX = 0; }); renderInspector(); };
  container.querySelector("#rstPanY").onclick = () => { store.updateDoc((d) => { d.frame.panY = 0; }); renderInspector(); };

  container.querySelector("#frBgMode").onchange = (e) => store.updateDoc((d) => { d.frame.bgMode = e.target.value; });
  container.querySelector("#frBg1").oninput = (e) => store.updateDoc((d) => { d.frame.bgColor = e.target.value; }, false);
  container.querySelector("#frBg2").oninput = (e) => store.updateDoc((d) => { d.frame.bgColor2 = e.target.value; }, false);
  container.querySelector("#frAspect").onchange = (e) => store.updateDoc((d) => { d.frame.aspect = e.target.value; });
  container.querySelector("#frFit").onchange = (e) => store.updateDoc((d) => { d.frame.fit = e.target.value; });
  container.querySelector("#frScale").oninput = (e) => {
    const v = parseFloat(e.target.value);
    container.querySelector("#vFrScale").textContent = `${Math.round(v * 100)}%`;
    store.updateDoc((d) => { d.frame.scale = v; }, false);
  };
  container.querySelector("#frPanX").oninput = (e) => {
    const v = parseFloat(e.target.value);
    container.querySelector("#vPanX").textContent = `${Math.round(v * 100)}%`;
    store.updateDoc((d) => { d.frame.panX = v; }, false);
  };
  container.querySelector("#frPanY").oninput = (e) => {
    const v = parseFloat(e.target.value);
    container.querySelector("#vPanY").textContent = `${Math.round(v * 100)}%`;
    store.updateDoc((d) => { d.frame.panY = v; }, false);
  };
}

/* ==========================================================================
   Export & Batch
   ========================================================================== */
async function runExport() {
  const st = store.get();
  if (!st.file || !st.meta) return;

  $("exportError").classList.remove("visible");
  $("expDoneBox").classList.remove("visible");
  $("expProgressBox").style.display = "flex";
  $("btnExportStart").disabled = true;
  $("btnExportCancel").style.display = "inline-flex";
  $("expBar").style.width = "2%";
  $("expPctLabel").textContent = "0.0%";
  $("expStageText").textContent = "Initializing…";

  expAbort = new AbortController();
  try {
    const res = await exportProject({
      file: st.file,
      meta: st.meta,
      peaks: st.peaks,
      doc: st.doc,
      mode: selectedExportMode,
      shortSide: parseInt($("expRes").value, 10),
      fps: parseInt($("expFps").value, 10),
      includeAudio: $("expIncludeAudio").checked,
      useDiskStream: $("expDiskStream").checked,
      signal: expAbort.signal,
      onProgress: (p) => {
        $("expBar").style.width = `${Math.min(100, p.percent)}%`;
        $("expPctLabel").textContent = `${p.percent.toFixed(1)}%`;
        $("expStageText").textContent = `${p.codecUsed} • ${p.diskStreamed ? "Disk Stream" : "Buffer"}`;
        $("expFrames").textContent = `Frame ${p.frame}/${p.totalFrames}`;
        $("expSpeed").textContent = `${p.fps.toFixed(1)} fps`;
        $("expEta").textContent = `ETA ${formatTime(p.etaSec)}`;
      },
    });
    $("expBar").style.width = "100%";
    $("expPctLabel").textContent = "100.0%";
    $("expDoneText").textContent = `Saved ${res.filename} (${res.width}×${res.height}) in ${res.elapsedSec.toFixed(1)}s!`;
    $("expDoneBox").classList.add("visible");
  } catch (err) {
    if (err?.name !== "AbortError") {
      $("exportError").textContent = err instanceof Error ? err.message : String(err);
      $("exportError").classList.add("visible");
    }
  } finally {
    expAbort = null;
    $("btnExportStart").disabled = false;
    $("btnExportCancel").style.display = "none";
  }
}

function renderBatchList() {
  const list = $("batchList");
  list.innerHTML = "";
  if (!batchQueue.length) {
    list.innerHTML = `<div class="section-card" style="text-align:center;color:var(--muted);">No files queued yet.</div>`;
    return;
  }
  batchQueue.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "batch-row";
    row.innerHTML = `
      <div style="min-width:0;flex:1;">
        <div style="font-weight:700;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${idx + 1}. ${item.name}</div>
        <div style="font-size:12px;color:var(--muted);">${item.detail}${item.error ? ` — ${item.error}` : ""}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="pill-status ${item.status === "done" ? "ok" : ""}">${item.percent.toFixed(0)}%</span>
        <button class="btn btn-ghost btn-sm btn-rm">✕</button>
      </div>
    `;
    row.querySelector(".btn-rm").onclick = () => { batchQueue.splice(idx, 1); renderBatchList(); };
    list.appendChild(row);
  });
}

async function runBatchQueue() {
  $("batchError").classList.remove("visible");
  if (!batchQueue.length) return;
  let dict;
  try { dict = parseVocabulary($("batchVocab").value); }
  catch (err) {
    $("batchError").textContent = err.message;
    $("batchError").classList.add("visible");
    return;
  }

  const tpl = getTemplate($("batchStyleSel").value);
  const mode = $("batchExportMode").value;
  const modelId = $("selModel").value;
  const lang = $("selLanguage").value;

  $("btnBatchRun").disabled = true;
  for (const item of batchQueue) {
    if (item.status === "done") continue;
    try {
      item.status = "processing";
      item.detail = "Extracting audio…";
      item.percent = 10;
      renderBatchList();

      const meta = await probeMedia(item.file);
      const { samples, peaks } = await extractAudio(item.file, (r) => { item.percent = 10 + r * 20; renderBatchList(); });

      item.detail = "Transcribing…";
      const { words: raw } = await transcribeAudio(samples, {
        model: modelId,
        language: lang,
        onProgress: (_s, r) => { item.percent = 30 + r * 35; renderBatchList(); },
      });

      const doc = createEmptyDoc(meta.isAudioOnly);
      doc.templateId = tpl.id;
      doc.style = structuredClone(tpl.style);
      const norm = tightenWords(normalizeWords(raw.map((w) => ({ id: uid("w"), ...w })), meta.duration), peaks);
      doc.pages = applyVocabulary(segmentWords(norm, { wordsPerPage: doc.style.wordsPerPage }), dict);

      item.status = "exporting";
      item.detail = "Exporting…";
      await exportProject({
        file: item.file,
        meta,
        peaks,
        doc,
        mode,
        shortSide: 0, // Original native resolution!
        fps: 0,       // Original native FPS!
        includeAudio: true,
        useDiskStream: false,
        onProgress: (p) => { item.percent = 65 + p.ratio * 35; item.detail = `Encoding ${p.percent.toFixed(0)}%`; renderBatchList(); },
      });

      item.status = "done";
      item.percent = 100;
      item.detail = "Done ✓";
    } catch (err) {
      item.status = "error";
      item.error = err instanceof Error ? err.message : String(err);
    }
    renderBatchList();
  }
  $("btnBatchRun").disabled = false;
}

init();

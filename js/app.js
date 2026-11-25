/**
 * CapStream — Main Application Controller (Powered by Unskyit)
 * Offline-First PWA • Editorial Upload Landing • Live MB & % Telemetry • 28 Styles • Transparent BG • Disk-Stream MP4 Export
 */
import { clearModelCache, defaultModel, getCachedModels, getModelInfo, LANGUAGES, MODELS, preloadModel, transcribeAudio } from "./asr-client.js";
import { applyVocabulary, createBatchItem, parseVocabulary } from "./batch.js";
import { detectCapabilities, exportProject } from "./exporter.js";
import { ensureFont, getFontNames, glyphsOf, loadFontManifest, onFontsChanged, weightsFor } from "./fonts.js";
import { extractAudio, probeMedia, tightenWords } from "./media.js";
import { cutsFor, frameSize, renderScene } from "./renderer.js";
import { normalizeWords, pageStart, pageText, resegment, retimeWords, segmentWords, uid } from "./segment.js";
import { createEmptyDoc, store } from "./store.js";
import { getTemplate, TEMPLATES } from "./templates.js";
import { cutTotal, downloadBlob, formatTime, parseSubtitles, skipTarget, toAss, toOutputTime, toPlainText, toSourceTime, toSrt, toVtt } from "./timeline.js";

const $ = (id) => document.getElementById(id);

const ICON_PLAY = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const ICON_PAUSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;

let procAbort = null;
let expAbort = null;
let preloadAbort = null;
let deferredInstallPrompt = null;
let rafId = null;
let selectedExportMode = "mp4-h264";
let capabilities = null;
let cachedModels = new Set();
let batchQueue = [];

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
    $("pwaStatusText").textContent = "App Installed";
    $("pwaStatusBadge").classList.add("ok");
  });
}

function updateOnlineBadge() {
  const badge = $("pwaStatusBadge");
  const text = $("pwaStatusText");
  if (!badge || !text) return;
  if (!navigator.onLine) {
    text.textContent = "Offline Mode";
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
    note.textContent = `${info.name} (${info.size}) saved locally — 0 MB to download.`;
    btnPre.style.display = "none";
  } else {
    badgeText.textContent = `Needs ${info.size}`;
    badge.className = "pill-status";
    note.textContent = `Downloads once (${info.size}), then runs 100% offline.`;
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
    opt.textContent = `${t.name}${t.category === "viral" ? " ★ Viral" : ""}`;
    batchStyleSel.appendChild(opt);
  }

  await loadFontManifest();
  capabilities = await detectCapabilities();
  $("capDiskText").textContent = capabilities.diskStream ? "Disk-Stream Ready (Unlimited Length)" : "Standard Download Mode";
  $("expDiskStream").checked = capabilities.diskStream;
  $("expDiskStream").disabled = !capabilities.diskStream;
  updateExportCapabilityNote();

  await refreshModelCacheUI();

  const draft = await store.loadDraft();
  if (draft?.file && draft?.meta && draft?.doc) {
    $("draftBannerText").textContent = `Resume draft: ${draft.meta.name} (${draft.doc.pages?.length || 0} captions)`;
    $("draftBanner").classList.add("visible");
  }

  bindEvents();
  onFontsChanged(() => drawPreviewFrame());
  store.subscribe(onStateChange);
  onStateChange(store.get());
}

function updateExportCapabilityNote() {
  if (!capabilities) return;
  const parts = [];
  parts.push(capabilities.diskStream ? "Disk streaming active (unlimited length, flat RAM)" : "Browser uses memory buffer (Chrome/Edge desktop enables disk streaming)");
  if (selectedExportMode === "webm-alpha") {
    parts.push(capabilities.vp9Alpha ? "VP9 Alpha supported ✓" : "VP9 Alpha not detected — try Chroma Key MP4 or PNG Sequence");
  } else if (selectedExportMode === "mp4-hevc") {
    parts.push(capabilities.hevc ? "H.265/HEVC hardware encoder supported ✓" : "HEVC not detected — will fall back to H.264 MP4");
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
    $("preloadText").textContent = `Downloading ${info.name} (${info.size})…`;
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
          $("preloadText").textContent = p.cached
            ? "Loaded from device cache ✓"
            : `${p.loadedMB.toFixed(1)} MB / ${tot.toFixed(1)} MB${spd}`;
          $("preloadPct").textContent = `${pct.toFixed(1)}%`;
          $("preloadBar").style.width = `${Math.max(2, pct)}%`;
        },
        preloadAbort.signal
      );
      $("preloadText").textContent = `${info.name} cached offline ✓`;
      $("preloadPct").textContent = "100.0%";
      $("preloadBar").style.width = "100%";
      await refreshModelCacheUI();
      setTimeout(() => $("preloadProgressWrap").classList.remove("visible"), 1800);
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

  $("chkLiveTelemetry").addEventListener("change", (e) => {
    store.set({ showLiveTelemetry: e.target.checked });
  });

  $("btnResumeDraft").addEventListener("click", async () => {
    const draft = await store.loadDraft();
    if (draft?.file && draft?.meta && draft?.doc) {
      openStudioWithProject(draft.file, draft.meta, draft.peaks, draft.doc);
    }
  });
  $("btnDiscardDraft").addEventListener("click", async () => {
    await store.clearDraft();
    $("draftBanner").classList.remove("visible");
  });

  $("btnCancelProc").addEventListener("click", () => {
    procAbort?.abort();
    store.set({ screen: "upload" });
  });

  $("btnNew").addEventListener("click", async () => {
    stopPlayback();
    await store.clearDraft();
    store.set({ screen: "upload", file: null, meta: null, error: null });
    $("draftBanner").classList.remove("visible");
    refreshModelCacheUI();
  });
  $("btnUndo").addEventListener("click", () => store.undo());
  $("btnRedo").addEventListener("click", () => store.redo());
  $("btnBatch").addEventListener("click", () => {
    stopPlayback();
    store.set({ screen: "batch" });
    renderBatchList();
  });
  $("btnBatchBack").addEventListener("click", () => {
    const st = store.get();
    store.set({ screen: st.file ? "studio" : "upload" });
  });

  $("quickAspect").addEventListener("change", (e) => {
    store.updateDoc((d) => { d.frame.aspect = e.target.value; });
    syncCanvasDimensions();
    drawPreviewFrame();
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
    if (!rawWords.length) return alert("No valid subtitle cues found in that file.");
    const st = store.get();
    const words = normalizeWords(rawWords, st.meta?.duration || Infinity);
    store.updateDoc((d) => {
      d.pages = segmentWords(words, { wordsPerPage: d.style.wordsPerPage });
    });
    renderInspector();
    drawPreviewFrame();
  });

  $("btnPlayPause").addEventListener("click", togglePlayback);
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

  $("btnExportOpen").addEventListener("click", () => {
    stopPlayback();
    $("exportError").classList.remove("visible");
    $("expDoneBox").classList.remove("visible");
    $("expProgressBox").style.display = "none";
    $("exportModal").classList.add("open");
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

  const dlSub = (ext, mime, content) => {
    const stem = (store.get().meta?.name || "captions").replace(/\.[^.]+$/, "");
    downloadBlob(new Blob([content], { type: mime }), `${stem}.${ext}`);
  };
  $("btnDlSrt").addEventListener("click", () => {
    const st = store.get();
    dlSub("srt", "text/plain;charset=utf-8", toSrt(st.doc.pages, st.doc.offset, cutsFor(st.doc, st.meta.duration)));
  });
  $("btnDlVtt").addEventListener("click", () => {
    const st = store.get();
    dlSub("vtt", "text/vtt;charset=utf-8", toVtt(st.doc.pages, st.doc.offset, cutsFor(st.doc, st.meta.duration)));
  });
  $("btnDlAss").addEventListener("click", () => {
    const st = store.get();
    dlSub("ass", "text/plain;charset=utf-8", toAss(st.doc.pages, st.doc.style, st.doc.offset, cutsFor(st.doc, st.meta.duration)));
  });
  $("btnDlTxt").addEventListener("click", () => {
    dlSub("txt", "text/plain;charset=utf-8", toPlainText(store.get().doc.pages));
  });

  $("btnBatchAdd").addEventListener("click", () => $("batchFilesInput").click());
  $("batchFilesInput").addEventListener("change", (e) => {
    for (const f of e.target.files || []) batchQueue.push(createBatchItem(f));
    e.target.value = "";
    renderBatchList();
  });
  $("btnBatchRun").addEventListener("click", runBatchQueue);
}

/* ==========================================================================
   Media Workflow
   ========================================================================== */
async function startMediaWorkflow(file) {
  $("uploadError").classList.remove("visible");
  procAbort = new AbortController();
  const signal = procAbort.signal;
  const startedAt = performance.now();

  store.set({ screen: "processing", error: null });
  $("telFile").textContent = file.name.slice(0, 26);
  $("telDownload").textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB media`;
  $("procTelemetryGrid").style.display = store.get().showLiveTelemetry ? "grid" : "none";

  const setProc = (stage, title, ratio, detail) => {
    const pct = Math.max(0, Math.min(100, ratio * 100));
    $("procStageText").textContent = stage;
    $("procTitle").textContent = title;
    $("procPct").textContent = `${pct.toFixed(1)}%`;
    $("procBar").style.width = `${Math.max(2, pct)}%`;
    $("procDetail").textContent = detail;
    $("telElapsed").textContent = formatTime((performance.now() - startedAt) / 1000);
  };

  try {
    setProc("Step 1 / 3", "Inspecting media file…", 0.05, "Reading video/audio streams locally…");
    const meta = await probeMedia(file);
    signal.throwIfAborted();

    if (!meta.hasAudio) {
      const doc = createEmptyDoc(false);
      openStudioWithProject(file, meta, new Float32Array(0), doc);
      return;
    }

    setProc("Step 2 / 3", "Extracting audio track…", 0.1, `Decoding ${formatTime(meta.duration)} of audio in streaming blocks…`);
    const { samples, peaks, duration } = await extractAudio(
      file,
      (r) => setProc("Step 2 / 3", "Extracting audio track…", r, `Decoded ${(r * 100).toFixed(0)}% of ${formatTime(meta.duration)}`),
      signal
    );
    if (!meta.duration && duration) meta.duration = duration;
    signal.throwIfAborted();

    const modelId = $("selModel").value;
    const modelInfo = getModelInfo(modelId);
    const language = $("selLanguage").value;
    setProc("Step 3 / 3", `Preparing ${modelInfo.name}…`, 0.02, `Checking local device cache (${modelInfo.size})…`);

    const { words: rawWords, language: detected } = await transcribeAudio(samples, {
      model: modelId,
      language,
      signal,
      onLanguage: (lang) => { $("telStatus").textContent = `Lang: ${lang.toUpperCase()}`; },
      onProgress: (stage, ratio, info) => {
        if (stage === "model") {
          const tot = info?.totalMB > 0 ? info.totalMB : modelInfo.sizeMB;
          const loaded = info?.loadedMB || 0;
          const spd = info?.speedMBps > 0.05 ? ` • ${info.speedMBps.toFixed(1)} MB/s` : "";
          $("telDownload").textContent = info?.cached ? "Cached Offline ✓" : `${loaded.toFixed(1)} / ${tot.toFixed(1)} MB`;
          setProc(
            "Downloading AI",
            `Caching ${modelInfo.name}…`,
            ratio,
            info?.cached ? "Loaded instantly from offline cache ✓" : `${loaded.toFixed(1)} MB of ${tot.toFixed(1)} MB${spd} (saved offline for next time)`
          );
        } else {
          $("telDownload").textContent = `Duration ${formatTime(meta.duration)}`;
          const chunkMsg = info?.totalChunks ? `Transcribing chunk ${info.chunk} of ${info.totalChunks}…` : "Transcribing speech…";
          setProc("Transcribing", "Generating word-level captions…", ratio, chunkMsg);
        }
      },
    });
    signal.throwIfAborted();

    refreshModelCacheUI();
    const normalized = tightenWords(normalizeWords(rawWords.map((w) => ({ id: uid("w"), ...w })), meta.duration), peaks);
    const doc = createEmptyDoc(meta.isAudioOnly);
    doc.pages = segmentWords(normalized, { wordsPerPage: doc.style.wordsPerPage });

    store.set({ detectedLanguage: detected });
    openStudioWithProject(file, meta, peaks, doc);
  } catch (err) {
    if (err?.name === "AbortError") return;
    store.set({ screen: "upload" });
    $("uploadError").textContent = err instanceof Error ? err.message : String(err);
    $("uploadError").classList.add("visible");
  }
}

/* ==========================================================================
   Studio & Live Canvas Playback
   ========================================================================== */
async function openStudioWithProject(file, meta, peaks, doc) {
  const prevUrl = store.get().mediaUrl;
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  const mediaUrl = URL.createObjectURL(file);

  const videoEl = $("hiddenVideo");
  const audioEl = $("hiddenAudio");
  videoEl.pause(); audioEl.pause();
  videoEl.removeAttribute("src"); audioEl.removeAttribute("src");

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
  store.scheduleDraftSave();

  await ensureFont(doc.style.font, doc.style.weight, doc.style.italic, glyphsOf(doc.pages));
  syncCanvasDimensions();
  renderInspector();

  const activeEl = getMediaEl();
  activeEl.onloadeddata = () => drawPreviewFrame();
  activeEl.onended = () => {
    store.set({ playing: false });
    $("btnPlayPause").innerHTML = ICON_PLAY;
  };
  drawPreviewFrame();
}

function getMediaEl() {
  return store.get().meta?.isAudioOnly ? $("hiddenAudio") : $("hiddenVideo");
}

function syncCanvasDimensions() {
  const st = store.get();
  if (!st.meta) return;
  const canvas = $("previewCanvas");
  const { width, height } = frameSize(st.meta, st.doc.frame.aspect, 720);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.classList.toggle("alpha-grid", st.doc.frame.bgMode === "transparent");
}

function drawPreviewFrame() {
  const st = store.get();
  if (st.screen !== "studio" || !st.meta) return;
  syncCanvasDimensions();
  const canvas = $("previewCanvas");
  const ctx = canvas.getContext("2d", { alpha: true });
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

  renderScene(ctx, srcObj, canvas.width, canvas.height, tSrc, tOut, outDur, st.doc, { peaks: st.peaks });

  $("timeCur").textContent = formatTime(tOut);
  $("timeDur").textContent = formatTime(outDur);
  $("scrubber").max = outDur.toFixed(2);
  $("scrubber").value = tOut.toFixed(2);
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
  drawPreviewFrame();
}

function tickPlayback() {
  const st = store.get();
  if (!st.playing) return;
  const el = getMediaEl();
  const cuts = cutsFor(st.doc, st.meta.duration);
  const jump = skipTarget(cuts, el.currentTime);
  if (jump !== null) el.currentTime = jump;
  drawPreviewFrame();
  rafId = requestAnimationFrame(tickPlayback);
}

/* ==========================================================================
   State Sync & Inspector Renderer
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
      : `${st.meta.width}×${st.meta.height} • ${formatTime(st.meta.duration)}`;
    $("quickAspect").value = st.doc.frame.aspect;
    const isTrans = st.doc.frame.bgMode === "transparent";
    $("btnToggleTransparentPreview").textContent = `Transparent BG: ${isTrans ? "ON" : "OFF"}`;
    $("btnToggleTransparentPreview").classList.toggle("btn-primary", isTrans);
    $("btnToggleTransparentPreview").classList.toggle("btn-secondary", !isTrans);
    drawPreviewFrame();
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

function renderStylesTab(container, st) {
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
      <div class="style-blurb">${tpl.blurb}</div>
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

function renderCustomizeTab(container, st) {
  const s = st.doc.style;
  const fonts = getFontNames();
  const weights = weightsFor(s.font);

  const card1 = document.createElement("div");
  card1.className = "section-card";
  card1.innerHTML = `
    <div class="section-title">Typography</div>
    <div class="control-grid-2">
      <div>
        <label class="field-label">Font Family</label>
        <select id="cFont" class="select">${fonts.map((f) => `<option value="${f}" ${f === s.font ? "selected" : ""}>${f}</option>`).join("")}</select>
      </div>
      <div>
        <label class="field-label">Weight</label>
        <select id="cWeight" class="select">${weights.map((w) => `<option value="${w}" ${w === s.weight ? "selected" : ""}>${w}</option>`).join("")}</select>
      </div>
    </div>
    <div class="control-grid-2">
      <div>
        <label class="field-label">Text Case</label>
        <select id="cCase" class="select">
          <option value="upper" ${s.textCase === "upper" ? "selected" : ""}>UPPERCASE</option>
          <option value="none" ${s.textCase === "none" ? "selected" : ""}>Original</option>
          <option value="lower" ${s.textCase === "lower" ? "selected" : ""}>lowercase</option>
        </select>
      </div>
      <div>
        <label class="field-label">Animation</label>
        <select id="cEntrance" class="select">
          ${["none", "pop", "fade", "rise", "drop", "zoom", "slide"].map((e) => `<option value="${e}" ${e === s.entrance ? "selected" : ""}>${e.toUpperCase()}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Font Size</span><strong id="vSize">${s.size.toFixed(1)}%</strong></div>
      <input id="cSize" type="range" min="3" max="15" step="0.2" value="${s.size}" />
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Vertical Position (Y)</span><strong id="vY">${Math.round(s.y * 100)}%</strong></div>
      <input id="cY" type="range" min="12" max="92" step="1" value="${Math.round(s.y * 100)}" />
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Words Per Caption</span><strong id="vWpp">${s.wordsPerPage}</strong></div>
      <input id="cWpp" type="range" min="1" max="8" step="1" value="${s.wordsPerPage}" />
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Active Word Pop Scale</span><strong id="vScale">${s.activeScale.toFixed(2)}x</strong></div>
      <input id="cScale" type="range" min="1" max="1.3" step="0.02" value="${s.activeScale}" />
    </div>
    <label class="toggle-row"><span>Show Punctuation</span><input id="cPunct" type="checkbox" class="switch" ${s.punctuation ? "checked" : ""} /></label>
    <label class="toggle-row"><span>Italic</span><input id="cItalic" type="checkbox" class="switch" ${s.italic ? "checked" : ""} /></label>
  `;
  container.appendChild(card1);

  const card2 = document.createElement("div");
  card2.className = "section-card";
  card2.innerHTML = `
    <div class="section-title">Colors &amp; Outline</div>
    <div class="control-row">
      <span style="font-size:12.5px;">Text Color</span>
      <input id="cColor" type="color" value="${s.color || "#FFFFFF"}" />
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Active Spoken Word</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <input id="cActiveColor" type="color" value="${s.activeColor || "#FFE600"}" />
        <input id="cActiveOn" type="checkbox" class="switch" ${s.activeColor ? "checked" : ""} />
      </div>
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Keyword Emphasis</span>
      <input id="cEmphColor" type="color" value="${s.emphasisColor || "#22FF66"}" />
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Outline Stroke</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <input id="cStrokeColor" type="color" value="${s.stroke?.color || "#000000"}" />
        <input id="cStrokeOn" type="checkbox" class="switch" ${s.stroke ? "checked" : ""} />
      </div>
    </div>
    <div class="range-wrap">
      <div class="range-head"><span>Stroke Thickness</span><strong id="vStroke">${((s.stroke?.width || 0.1) * 100).toFixed(0)}</strong></div>
      <input id="cStrokeW" type="range" min="2" max="22" step="1" value="${Math.round((s.stroke?.width || 0.1) * 100)}" />
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Active Word Pill Box</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <input id="cPillColor" type="color" value="${s.activeBox?.color || "#2563EB"}" />
        <input id="cPillOn" type="checkbox" class="switch" ${s.activeBox ? "checked" : ""} />
      </div>
    </div>
    <div class="control-row">
      <span style="font-size:12.5px;">Background Box</span>
      <select id="cBoxScope" class="select" style="width:auto;">
        <option value="none" ${!s.box ? "selected" : ""}>None</option>
        <option value="line" ${s.box?.scope === "line" ? "selected" : ""}>Per Line</option>
        <option value="page" ${s.box?.scope === "page" ? "selected" : ""}>Full Block</option>
      </select>
    </div>
  `;
  container.appendChild(card2);

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
  card2.querySelector("#cActiveOn").onchange = (e) => {
    store.updateDoc((d) => { d.style.activeColor = e.target.checked ? card2.querySelector("#cActiveColor").value : null; });
  };
  card2.querySelector("#cEmphColor").oninput = (e) => store.updateDoc((d) => { d.style.emphasisColor = e.target.value; }, false);
  card2.querySelector("#cStrokeColor").oninput = (e) => {
    card2.querySelector("#cStrokeOn").checked = true;
    store.updateDoc((d) => { d.style.stroke = { color: e.target.value, width: d.style.stroke?.width ?? 0.1 }; }, false);
  };
  card2.querySelector("#cStrokeOn").onchange = (e) => {
    store.updateDoc((d) => { d.style.stroke = e.target.checked ? { color: card2.querySelector("#cStrokeColor").value, width: 0.1 } : null; });
  };
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
  card2.querySelector("#cPillOn").onchange = (e) => {
    store.updateDoc((d) => { d.style.activeBox = e.target.checked ? { color: card2.querySelector("#cPillColor").value, radius: 0.24, padX: 0.2, padY: 0.06 } : null; });
  };
  card2.querySelector("#cBoxScope").onchange = (e) => {
    const v = e.target.value;
    store.updateDoc((d) => {
      d.style.box = v === "none" ? null : { color: "rgba(11,22,44,0.88)", radius: 0.26, padX: 0.45, padY: 0.2, scope: v };
    });
  };
}

function renderTranscriptTab(container, st) {
  if (!st.doc.pages.length) {
    container.innerHTML = `<div class="section-card"><p style="color:var(--muted);">No captions yet. Import an .SRT/.VTT file or add a caption manually.</p><button id="btnAddFirstCap" class="btn btn-primary btn-sm">+ Add Caption</button></div>`;
    container.querySelector("#btnAddFirstCap").onclick = () => {
      store.updateDoc((d) => {
        d.pages.push({ id: uid("p"), words: [{ id: uid("w"), text: "Hello", start: 0, end: 1 }, { id: uid("w"), text: "world!", start: 1, end: 2 }] });
      });
      renderInspector();
    };
    return;
  }

  const tip = document.createElement("div");
  tip.style.cssText = "font-size:12px;color:var(--faint);";
  tip.textContent = "Edit text below, click a timestamp to seek, or tap a word chip to toggle keyword highlight.";
  container.appendChild(tip);

  st.doc.pages.forEach((page, idx) => {
    const card = document.createElement("div");
    card.className = "page-card";
    card.innerHTML = `
      <div class="page-head">
        <button class="btn-seek" style="color:var(--blue);font-weight:700;">${formatTime(pageStart(page))}</button>
        <div style="display:flex;gap:4px;">
          <input class="emoji-in" type="text" placeholder="Emoji" value="${page.emoji ?? ""}" style="width:46px;background:var(--subtle);border:1px solid var(--line);border-radius:6px;padding:2px 4px;text-align:center;font-size:12px;" />
          ${idx < st.doc.pages.length - 1 ? '<button class="btn btn-ghost btn-sm btn-join" title="Join with next">Join</button>' : ""}
          <button class="btn btn-ghost btn-sm btn-del" title="Delete caption" style="color:var(--err-ink);">✕</button>
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
    card.querySelector(".emoji-in").onchange = (e) => {
      const val = e.target.value.trim();
      store.updateDoc((d) => { d.pages[idx].emoji = val || null; });
    };
    card.querySelector(".btn-del").onclick = () => {
      store.updateDoc((d) => { d.pages.splice(idx, 1); });
      renderInspector();
    };
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

function renderEffectsTab(container, st) {
  const fx = st.doc.fx;
  container.innerHTML = `
    <div class="section-card">
      <div class="section-title">Sync Offset</div>
      <div class="range-wrap">
        <div class="range-head"><span>Caption Timing Nudge</span><strong id="vOffset">${(st.doc.offset >= 0 ? "+" : "") + st.doc.offset.toFixed(2)}s</strong></div>
        <input id="fxOffset" type="range" min="-2" max="2" step="0.05" value="${st.doc.offset}" />
      </div>
    </div>
    <div class="section-card">
      <div class="section-title">Auto Emoji</div>
      <label class="toggle-row"><span>Enable Auto Emoji</span><input id="fxEmoji" type="checkbox" class="switch" ${fx.emoji.enabled ? "checked" : ""} /></label>
      <div class="range-wrap">
        <div class="range-head"><span>Emoji Size</span><strong id="vEmojiSz">${fx.emoji.size.toFixed(1)}x</strong></div>
        <input id="fxEmojiSz" type="range" min="0.8" max="2.4" step="0.1" value="${fx.emoji.size}" />
      </div>
    </div>
    <div class="section-card">
      <div class="section-title">Hook Title Card</div>
      <label class="toggle-row"><span>Show Opening Hook</span><input id="fxHook" type="checkbox" class="switch" ${fx.hook.enabled ? "checked" : ""} /></label>
      <input id="fxHookText" class="input" type="text" placeholder="e.g. Watch until the end..." value="${fx.hook.text.replace(/"/g, "&quot;")}" />
      <div class="control-grid-2">
        <div class="control-row"><span style="font-size:12px;">Text</span><input id="fxHookCol" type="color" value="${fx.hook.color}" /></div>
        <div class="control-row"><span style="font-size:12px;">Box</span><input id="fxHookBg" type="color" value="${fx.hook.background}" /></div>
      </div>
    </div>
    <div class="section-card">
      <div class="section-title">Progress Bar &amp; Dynamic Motion</div>
      <label class="toggle-row"><span>Progress Bar</span><input id="fxProg" type="checkbox" class="switch" ${fx.progress.enabled ? "checked" : ""} /></label>
      <div class="control-grid-2">
        <select id="fxProgPos" class="select">
          <option value="bottom" ${fx.progress.position === "bottom" ? "selected" : ""}>Bottom</option>
          <option value="top" ${fx.progress.position === "top" ? "selected" : ""}>Top</option>
        </select>
        <div class="control-row"><span style="font-size:12px;">Color</span><input id="fxProgCol" type="color" value="${fx.progress.color}" /></div>
      </div>
      <label class="toggle-row"><span>Auto Dynamic Zoom</span><input id="fxZoom" type="checkbox" class="switch" ${fx.zoom.enabled ? "checked" : ""} /></label>
      <label class="toggle-row"><span>Smart Silence Jump Cuts</span><input id="fxCuts" type="checkbox" class="switch" ${fx.cuts.enabled ? "checked" : ""} /></label>
      <select id="fxPace" class="select">
        <option value="natural" ${fx.cuts.pace === "natural" ? "selected" : ""}>Pace: Natural</option>
        <option value="fast" ${fx.cuts.pace === "fast" ? "selected" : ""}>Pace: Fast</option>
        <option value="extra" ${fx.cuts.pace === "extra" ? "selected" : ""}>Pace: Extra Tight</option>
      </select>
    </div>
  `;
  container.querySelector("#fxOffset").oninput = (e) => {
    const v = parseFloat(e.target.value);
    container.querySelector("#vOffset").textContent = `${v >= 0 ? "+" : ""}${v.toFixed(2)}s`;
    store.updateDoc((d) => { d.offset = v; }, false);
  };
  container.querySelector("#fxEmoji").onchange = (e) => store.updateDoc((d) => { d.fx.emoji.enabled = e.target.checked; });
  container.querySelector("#fxEmojiSz").oninput = (e) => {
    const v = parseFloat(e.target.value);
    container.querySelector("#vEmojiSz").textContent = `${v.toFixed(1)}x`;
    store.updateDoc((d) => { d.fx.emoji.size = v; }, false);
  };
  container.querySelector("#fxHook").onchange = (e) => store.updateDoc((d) => { d.fx.hook.enabled = e.target.checked; });
  container.querySelector("#fxHookText").oninput = (e) => store.updateDoc((d) => { d.fx.hook.text = e.target.value; }, false);
  container.querySelector("#fxHookCol").oninput = (e) => store.updateDoc((d) => { d.fx.hook.color = e.target.value; }, false);
  container.querySelector("#fxHookBg").oninput = (e) => store.updateDoc((d) => { d.fx.hook.background = e.target.value; }, false);
  container.querySelector("#fxProg").onchange = (e) => store.updateDoc((d) => { d.fx.progress.enabled = e.target.checked; });
  container.querySelector("#fxProgPos").onchange = (e) => store.updateDoc((d) => { d.fx.progress.position = e.target.value; });
  container.querySelector("#fxProgCol").oninput = (e) => store.updateDoc((d) => { d.fx.progress.color = e.target.value; }, false);
  container.querySelector("#fxZoom").onchange = (e) => store.updateDoc((d) => { d.fx.zoom.enabled = e.target.checked; });
  container.querySelector("#fxCuts").onchange = (e) => store.updateDoc((d) => { d.fx.cuts.enabled = e.target.checked; });
  container.querySelector("#fxPace").onchange = (e) => store.updateDoc((d) => { d.fx.cuts.pace = e.target.value; });
}

function renderFrameTab(container, st) {
  const f = st.doc.frame;
  container.innerHTML = `
    <div class="section-card">
      <div class="section-title">Canvas Background Mode</div>
      <select id="frBgMode" class="select">
        ${!st.meta?.isAudioOnly ? `<option value="video" ${f.bgMode === "video" ? "selected" : ""}>Original Video</option>` : ""}
        <option value="transparent" ${f.bgMode === "transparent" ? "selected" : ""}>Transparent Alpha (Overlay)</option>
        <option value="chroma-green" ${f.bgMode === "chroma-green" ? "selected" : ""}>Chroma Key Green (#00FF00)</option>
        <option value="chroma-blue" ${f.bgMode === "chroma-blue" ? "selected" : ""}>Chroma Key Blue (#0000FF)</option>
        <option value="waveform" ${f.bgMode === "waveform" ? "selected" : ""}>Audio Waveform + Navy Gradient</option>
        <option value="gradient" ${f.bgMode === "gradient" ? "selected" : ""}>Navy Blue Gradient</option>
        <option value="solid" ${f.bgMode === "solid" ? "selected" : ""}>Solid Custom Color</option>
      </select>
      <div class="control-grid-2">
        <div class="control-row"><span style="font-size:12px;">BG Color 1</span><input id="frBg1" type="color" value="${f.bgColor}" /></div>
        <div class="control-row"><span style="font-size:12px;">BG Color 2</span><input id="frBg2" type="color" value="${f.bgColor2}" /></div>
      </div>
    </div>
    <div class="section-card">
      <div class="section-title">Reframing &amp; Crop</div>
      <div class="control-grid-2">
        <div>
          <label class="field-label">Aspect Ratio</label>
          <select id="frAspect" class="select">
            <option value="source" ${f.aspect === "source" ? "selected" : ""}>Source</option>
            <option value="9:16" ${f.aspect === "9:16" ? "selected" : ""}>9:16 Vertical</option>
            <option value="4:5" ${f.aspect === "4:5" ? "selected" : ""}>4:5 Portrait</option>
            <option value="1:1" ${f.aspect === "1:1" ? "selected" : ""}>1:1 Square</option>
            <option value="16:9" ${f.aspect === "16:9" ? "selected" : ""}>16:9 Widescreen</option>
          </select>
        </div>
        <div>
          <label class="field-label">Video Fit</label>
          <select id="frFit" class="select">
            <option value="cover" ${f.fit === "cover" ? "selected" : ""}>Crop to Fill</option>
            <option value="blur" ${f.fit === "blur" ? "selected" : ""}>Blurred Backdrop</option>
            <option value="contain" ${f.fit === "contain" ? "selected" : ""}>Fit Inside</option>
          </select>
        </div>
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Horizontal Pan</span><strong>${Math.round(f.panX * 100)}%</strong></div>
        <input id="frPanX" type="range" min="-1" max="1" step="0.05" value="${f.panX}" />
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Vertical Pan</span><strong>${Math.round(f.panY * 100)}%</strong></div>
        <input id="frPanY" type="range" min="-1" max="1" step="0.05" value="${f.panY}" />
      </div>
    </div>
  `;
  container.querySelector("#frBgMode").onchange = (e) => store.updateDoc((d) => { d.frame.bgMode = e.target.value; });
  container.querySelector("#frBg1").oninput = (e) => store.updateDoc((d) => { d.frame.bgColor = e.target.value; }, false);
  container.querySelector("#frBg2").oninput = (e) => store.updateDoc((d) => { d.frame.bgColor2 = e.target.value; }, false);
  container.querySelector("#frAspect").onchange = (e) => store.updateDoc((d) => { d.frame.aspect = e.target.value; });
  container.querySelector("#frFit").onchange = (e) => store.updateDoc((d) => { d.frame.fit = e.target.value; });
  container.querySelector("#frPanX").oninput = (e) => store.updateDoc((d) => { d.frame.panX = parseFloat(e.target.value); }, false);
  container.querySelector("#frPanY").oninput = (e) => store.updateDoc((d) => { d.frame.panY = parseFloat(e.target.value); }, false);
}

/* ==========================================================================
   Export Execution & Batch Queue
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
  $("expStageText").textContent = "Initializing encoder…";

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
        $("expStageText").textContent = `${p.codecUsed} • ${p.diskStreamed ? "Streaming to Disk" : "Memory Buffer"}`;
        $("expFrames").textContent = `Frame ${p.frame} / ${p.totalFrames}`;
        $("expSpeed").textContent = `${p.fps.toFixed(1)} fps (${p.speedX.toFixed(2)}x)`;
        $("expEta").textContent = `ETA ${formatTime(p.etaSec)}`;
      },
    });
    $("expBar").style.width = "100%";
    $("expPctLabel").textContent = "100.0%";
    $("expDoneText").textContent = `Saved ${res.filename} (${res.width}×${res.height}, ${res.codecUsed}) in ${res.elapsedSec.toFixed(1)}s!`;
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
    list.innerHTML = `<div class="section-card" style="text-align:center;color:var(--muted);">No files queued yet. Click <strong>+ Add Files</strong> to select multiple videos or audio files.</div>`;
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
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="pill-status ${item.status === "done" ? "ok" : ""}">${item.percent.toFixed(0)}%</span>
        <button class="btn btn-ghost btn-sm btn-rm">✕</button>
      </div>
    `;
    row.querySelector(".btn-rm").onclick = () => {
      batchQueue.splice(idx, 1);
      renderBatchList();
    };
    list.appendChild(row);
  });
}

async function runBatchQueue() {
  $("batchError").classList.remove("visible");
  if (!batchQueue.length) return;
  let dict;
  try {
    dict = parseVocabulary($("batchVocab").value);
  } catch (err) {
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
      item.detail = "Probing & extracting audio…";
      item.percent = 10;
      renderBatchList();

      const meta = await probeMedia(item.file);
      const { samples, peaks } = await extractAudio(item.file, (r) => {
        item.percent = 10 + r * 20;
        renderBatchList();
      });

      item.detail = "Transcribing with Whisper AI…";
      const { words: raw } = await transcribeAudio(samples, {
        model: modelId,
        language: lang,
        onProgress: (_s, r) => {
          item.percent = 30 + r * 35;
          renderBatchList();
        },
      });

      const doc = createEmptyDoc(meta.isAudioOnly);
      doc.templateId = tpl.id;
      doc.style = structuredClone(tpl.style);
      const norm = tightenWords(normalizeWords(raw.map((w) => ({ id: uid("w"), ...w })), meta.duration), peaks);
      doc.pages = applyVocabulary(segmentWords(norm, { wordsPerPage: doc.style.wordsPerPage }), dict);

      item.status = "exporting";
      item.detail = `Exporting (${mode})…`;
      await exportProject({
        file: item.file,
        meta,
        peaks,
        doc,
        mode,
        shortSide: 1080,
        fps: 30,
        includeAudio: true,
        useDiskStream: false,
        onProgress: (p) => {
          item.percent = 65 + p.ratio * 35;
          item.detail = `Encoding ${p.percent.toFixed(0)}% (${p.fps.toFixed(1)} fps)`;
          renderBatchList();
        },
      });

      item.status = "done";
      item.percent = 100;
      item.detail = "Exported ✓";
    } catch (err) {
      item.status = "error";
      item.error = err instanceof Error ? err.message : String(err);
    }
    renderBatchList();
  }
  $("btnBatchRun").disabled = false;
}

init();

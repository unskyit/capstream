/**
 * CapStream — Disk-Streamed & Original-Quality Export Engine
 * Powered by Unskyit
 */
import { ensureFont, glyphsOf } from "./fonts.js";
import { getMediabunny } from "./media.js";
import { cutsFor, frameSize, renderScene } from "./renderer.js";
import { cutTotal, downloadBlob, keptRanges, toSourceTime } from "./timeline.js";

const LOCAL_AAC_URL = "../vendor/aac-encoder.mjs";
const CDN_AAC_URL = "https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.66.0/+esm";
const FADE = 0.006;

const cancelled = () => new DOMException("Export cancelled", "AbortError");

async function loadAacEncoder() {
  try {
    return await import(LOCAL_AAC_URL);
  } catch {
    return await import(CDN_AAC_URL);
  }
}

export function supportsDiskStream() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

export function supportsFolderStream() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function supportsWebCodecs() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

export async function detectCapabilities() {
  const caps = {
    webCodecs: supportsWebCodecs(),
    diskStream: supportsDiskStream(),
    folderStream: supportsFolderStream(),
    h264: false,
    hevc: false,
    vp9Alpha: false,
  };
  if (!caps.webCodecs) return caps;
  try {
    const h264 = await VideoEncoder.isConfigSupported({ codec: "avc1.42001f", width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 });
    caps.h264 = !!h264?.supported;
  } catch {}
  try {
    const hevc = await VideoEncoder.isConfigSupported({ codec: "hev1.1.6.L93.B0", width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 });
    caps.hevc = !!hevc?.supported;
  } catch {}
  try {
    const vp9 = await VideoEncoder.isConfigSupported({ codec: "vp09.00.10.08", width: 1280, height: 720, bitrate: 2_000_000, framerate: 30, alpha: "keep" });
    caps.vp9Alpha = !!vp9?.supported;
  } catch {}
  return caps;
}

export function makeExportFilename(sourceName, mode) {
  const stem = (sourceName || "capstream-project")
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .trim()
    .slice(0, 100) || "capstream";
  if (mode === "webm-alpha") return `${stem}-transparent-alpha.webm`;
  if (mode === "mp4-hevc") return `${stem}-hevc.mp4`;
  if (mode === "chroma-green") return `${stem}-chroma-green.mp4`;
  if (mode === "chroma-blue") return `${stem}-chroma-blue.mp4`;
  return `${stem}-capstream.mp4`;
}

function silence(seconds, rate, channels) {
  return new AudioBuffer({
    length: Math.max(1, Math.round(seconds * rate)),
    numberOfChannels: channels,
    sampleRate: rate,
  });
}

function sliceAudio(buffer, from, to, fadeIn, fadeOut) {
  if (from === 0 && to === buffer.length && !fadeIn && !fadeOut) return buffer;
  const out = new AudioBuffer({
    length: Math.max(1, to - from),
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  const ramp = Math.min(out.length, Math.round(FADE * buffer.sampleRate));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c).slice(from, to);
    if (fadeIn) for (let i = 0; i < ramp; i++) data[i] *= i / ramp;
    if (fadeOut) for (let i = 0; i < ramp; i++) data[data.length - 1 - i] *= i / ramp;
    out.copyToChannel(data, c);
  }
  return out;
}

async function writeAudioTrack(track, source, kept, signal, AudioBufferSink) {
  const sink = new AudioBufferSink(track);
  let rate = await track.getSampleRate();
  let channels = await track.getNumberOfChannels();
  for (let k = 0; k < kept.length; k++) {
    const range = kept[k];
    let at = range.start;
    for await (const { buffer, timestamp } of sink.buffers(range.start, range.end)) {
      if (signal?.aborted) throw cancelled();
      rate = buffer.sampleRate;
      channels = buffer.numberOfChannels;
      const from = Math.max(at, timestamp);
      const to = Math.min(range.end, timestamp + buffer.length / rate);
      if (to <= from) continue;
      if (from - at > 0.002) await source.add(silence(from - at, rate, channels));
      const a = Math.max(0, Math.round((from - timestamp) * rate));
      const b = Math.min(buffer.length, Math.round((to - timestamp) * rate));
      if (b > a) {
        const startsRange = from - range.start < 0.001 && k > 0;
        const endsRange = range.end - to < 0.001 && k < kept.length - 1;
        await source.add(sliceAudio(buffer, a, b, startsRange, endsRange));
      }
      at = to;
    }
    if (range.end - at > 0.002) await source.add(silence(range.end - at, rate, channels));
  }
  source.close();
}

async function exportPngSequence({ doc, meta, peaks, shortSide, fps, onProgress, signal }) {
  if (!supportsFolderStream()) {
    throw new Error("Direct-to-folder PNG Sequence export requires Chrome or Edge on desktop.");
  }
  const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  const targetFps = fps > 0 ? fps : Math.round(meta.fps || 30);
  const { width: W, height: H } = frameSize(meta, doc.frame.aspect, shortSide);
  const cuts = cutsFor(doc, meta.duration);
  const outDuration = Math.max(1 / targetFps, meta.duration - cutTotal(cuts, meta.duration));
  const totalFrames = Math.max(1, Math.round(outDuration * targetFps));

  await ensureFont(doc.style.font, doc.style.weight, doc.style.italic, glyphsOf(doc.pages));

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: true });

  const startMs = performance.now();
  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) throw cancelled();
    const tOut = i / targetFps;
    const tSrc = toSourceTime(cuts, tOut);
    renderScene(ctx, null, W, H, tSrc, tOut, outDuration, doc, { forceBgMode: "transparent", peaks });
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const fname = `frame_${String(i + 1).padStart(6, "0")}.png`;
    const fh = await dirHandle.getFileHandle(fname, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();

    if (i % 2 === 0 || i === totalFrames - 1) {
      const elapsedSec = (performance.now() - startMs) / 1000;
      const ratio = (i + 1) / totalFrames;
      const curFps = (i + 1) / Math.max(0.01, elapsedSec);
      onProgress?.({
        ratio,
        percent: ratio * 100,
        frame: i + 1,
        totalFrames,
        fps: curFps,
        speedX: curFps / targetFps,
        elapsedSec,
        etaSec: (totalFrames - (i + 1)) / Math.max(0.01, curFps),
        diskStreamed: true,
        codecUsed: "PNG RGBA (Lossless Alpha)",
      });
    }
  }
  return {
    diskStreamed: true,
    filename: `${dirHandle.name}/ (frame_000001.png … frame_${String(totalFrames).padStart(6, "0")}.png)`,
    codecUsed: "PNG RGBA Sequence",
    width: W,
    height: H,
    totalFrames,
    elapsedSec: (performance.now() - startMs) / 1000,
  };
}

export async function exportProject(options) {
  const {
    file,
    meta,
    peaks,
    doc,
    mode = "mp4-h264",
    shortSide = 0, // 0 = Original Native Resolution!
    fps = 0,       // 0 = Original Native FPS!
    includeAudio = true,
    useDiskStream = true,
    onProgress,
    signal,
  } = options;

  if (mode === "png-sequence") return exportPngSequence(options);

  if (!supportsWebCodecs()) {
    throw new Error("Your browser does not support WebCodecs video encoding. Please use Chrome, Edge, or Safari 16.4+.");
  }

  const mb = await getMediabunny();
  const {
    ALL_FORMATS,
    AudioBufferSink,
    AudioBufferSource,
    BlobSource,
    BufferTarget,
    StreamTarget,
    CanvasSource,
    Input,
    Mp4OutputFormat,
    WebMOutputFormat,
    Output,
    Quality,
    VideoSampleSink,
    canEncodeAudio,
    getFirstEncodableVideoCodec,
  } = mb;

  const isAlphaWebm = mode === "webm-alpha";
  const isChromaGreen = mode === "chroma-green";
  const isChromaBlue = mode === "chroma-blue";
  const isHevc = mode === "mp4-hevc";
  const isOverlayOnly = isAlphaWebm || isChromaGreen || isChromaBlue;

  const targetFps = fps > 0 ? fps : Math.max(24, Math.min(60, Math.round(meta.fps || 30)));
  const { width: W, height: H } = frameSize(meta, doc.frame.aspect, shortSide);
  const cuts = cutsFor(doc, meta.duration);
  const outDuration = Math.max(1 / targetFps, meta.duration - cutTotal(cuts, meta.duration));
  const totalFrames = Math.max(1, Math.round(outDuration * targetFps));
  const filename = makeExportFilename(meta.name, mode);

  await ensureFont(doc.style.font, doc.style.weight, doc.style.italic, glyphsOf(doc.pages));

  let writableStream = null;
  let diskStreamed = false;
  let target;
  if (useDiskStream && supportsDiskStream() && typeof StreamTarget === "function") {
    try {
      const ext = isAlphaWebm ? ".webm" : ".mp4";
      const mime = isAlphaWebm ? "video/webm" : "video/mp4";
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: isAlphaWebm ? "Transparent WebM Video" : "MP4 Video", accept: { [mime]: [ext] } }],
      });
      writableStream = await handle.createWritable();
      target = new StreamTarget(writableStream);
      diskStreamed = true;
    } catch (err) {
      if (err?.name === "AbortError") throw cancelled();
      target = new BufferTarget();
      diskStreamed = false;
    }
  } else {
    target = new BufferTarget();
    diskStreamed = false;
  }

  let format;
  if (isAlphaWebm) {
    format = new WebMOutputFormat();
  } else {
    try {
      format = new Mp4OutputFormat({ fastStart: diskStreamed ? "fragmented" : "in-memory" });
    } catch {
      format = new Mp4OutputFormat({ fastStart: false });
    }
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({ format, target });

  try {
    const videoTrack = !meta.isAudioOnly && !isOverlayOnly ? await input.getPrimaryVideoTrack().catch(() => null) : null;
    const audioTrack = includeAudio && meta.hasAudio ? await input.getPrimaryAudioTrack().catch(() => null) : null;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { alpha: isAlphaWebm });
    if (!ctx) throw new Error("Could not initialize 2D drawing surface.");

    // High-quality bitrate scaled for native resolution (preserves sharp 1080p/1440p/4K detail)
    const quality = new Quality({ bitrate: Math.round(W * H * (isAlphaWebm ? 0.16 : 0.13) * 30 * (targetFps / 30) ** 0.65) });

    let codecList = ["avc"];
    if (isAlphaWebm) codecList = ["vp9"];
    else if (isHevc) codecList = ["hevc", "avc"];

    const codec = await getFirstEncodableVideoCodec(codecList, {
      width: W,
      height: H,
      quality,
      frameRate: targetFps,
      ...(isAlphaWebm ? { alpha: "keep" } : {}),
    });

    if (!codec) {
      throw new Error(
        isAlphaWebm
          ? "This browser cannot encode Transparent VP9 WebM at this resolution. Try 1080p, Chroma Key MP4, or PNG Sequence."
          : "This browser cannot encode video at this resolution. Try 1080p or 720p in Chrome/Edge."
      );
    }

    const videoSource = new CanvasSource(canvas, {
      codec,
      quality,
      keyFrameInterval: 2,
      ...(isAlphaWebm ? { alpha: "keep" } : {}),
    });
    output.addVideoTrack(videoSource, { frameRate: targetFps });

    let audioSource = null;
    if (audioTrack && (await audioTrack.canDecode().catch(() => false))) {
      const targetAudioCodec = isAlphaWebm ? "opus" : "aac";
      if (targetAudioCodec === "aac" && !(await canEncodeAudio("aac"))) {
        try {
          const { registerAacEncoder } = await loadAacEncoder();
          registerAacEncoder();
        } catch {}
      }
      if (await canEncodeAudio(targetAudioCodec).catch(() => false)) {
        audioSource = new AudioBufferSource({
          codec: targetAudioCodec,
          quality: new Quality({ bitrate: 192_000 }),
          transform: { sampleRate: 48_000, numberOfChannels: 2 },
        });
        output.addAudioTrack(audioSource);
      }
    }

    await output.start();
    const startMs = performance.now();
    const forceBgMode = isAlphaWebm ? "transparent" : isChromaGreen ? "chroma-green" : isChromaBlue ? "chroma-blue" : null;

    const writeVideoFrames = async () => {
      if (videoTrack && !isOverlayOnly) {
        const first = await videoTrack.getFirstTimestamp();
        const sourceTime = (i) => Math.max(first, toSourceTime(cuts, i / targetFps));
        function* stamps() {
          for (let i = 0; i < totalFrames; i++) yield sourceTime(i);
        }
        let i = 0;
        for await (const sample of new VideoSampleSink(videoTrack).samplesAtTimestamps(stamps())) {
          if (signal?.aborted) {
            sample?.close();
            throw cancelled();
          }
          const tOut = i / targetFps;
          renderScene(
            ctx,
            sample && {
              width: sample.displayWidth,
              height: sample.displayHeight,
              draw: (c, sx, sy, sw, sh, dx, dy, dw, dh) => sample.draw(c, sx, sy, sw, sh, dx, dy, dw, dh),
            },
            W, H, sourceTime(i), tOut, outDuration, doc, { forceBgMode, peaks }
          );
          sample?.close();
          await videoSource.add(tOut, 1 / targetFps);
          i++;
          if (i % 3 === 0 || i === totalFrames) {
            const elapsedSec = (performance.now() - startMs) / 1000;
            const ratio = i / totalFrames;
            const curFps = i / Math.max(0.01, elapsedSec);
            onProgress?.({
              ratio,
              percent: ratio * 100,
              frame: i,
              totalFrames,
              fps: curFps,
              speedX: curFps / targetFps,
              elapsedSec,
              etaSec: (totalFrames - i) / Math.max(0.01, curFps),
              diskStreamed,
              codecUsed: codec.toUpperCase(),
            });
          }
        }
      } else {
        for (let i = 0; i < totalFrames; i++) {
          if (signal?.aborted) throw cancelled();
          const tOut = i / targetFps;
          const tSrc = toSourceTime(cuts, tOut);
          renderScene(ctx, null, W, H, tSrc, tOut, outDuration, doc, { forceBgMode, peaks });
          await videoSource.add(tOut, 1 / targetFps);
          if ((i + 1) % 4 === 0 || i === totalFrames - 1) {
            const elapsedSec = (performance.now() - startMs) / 1000;
            const ratio = (i + 1) / totalFrames;
            const curFps = (i + 1) / Math.max(0.01, elapsedSec);
            onProgress?.({
              ratio,
              percent: ratio * 100,
              frame: i + 1,
              totalFrames,
              fps: curFps,
              speedX: curFps / targetFps,
              elapsedSec,
              etaSec: (totalFrames - (i + 1)) / Math.max(0.01, curFps),
              diskStreamed,
              codecUsed: isAlphaWebm ? "VP9 ALPHA" : codec.toUpperCase(),
            });
          }
        }
      }
      videoSource.close();
    };

    await Promise.all([
      writeVideoFrames(),
      audioTrack && audioSource
        ? writeAudioTrack(audioTrack, audioSource, keptRanges(cuts, meta.duration), signal, AudioBufferSink)
        : null,
    ]);

    await output.finalize();
    if (writableStream) await writableStream.close().catch(() => {});

    const elapsedSec = (performance.now() - startMs) / 1000;
    let blob = null;
    if (!diskStreamed) {
      if (!target.buffer) throw new Error("Export produced no output data.");
      blob = new Blob([target.buffer], { type: isAlphaWebm ? "video/webm" : "video/mp4" });
      downloadBlob(blob, filename);
    }

    return {
      blob,
      diskStreamed,
      filename,
      codecUsed: isAlphaWebm ? "VP9 Alpha (WebM)" : codec.toUpperCase(),
      width: W,
      height: H,
      totalFrames,
      elapsedSec,
    };
  } catch (err) {
    await output.cancel().catch(() => {});
    if (writableStream) await writableStream.abort().catch(() => {});
    throw err;
  } finally {
    input.dispose();
  }
}

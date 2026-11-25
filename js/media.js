/**
 * CapStream — Universal Video & Audio Media Loader (Local Vendor + CDN Fallback)
 * Powered by Unskyit
 */

export const SPEECH_RATE = 16000;
export const PEAK_RATE = 50;

const LOCAL_MB_URL = "../vendor/mediabunny.mjs";
const CDN_MB_URL = "https://cdn.jsdelivr.net/npm/mediabunny@1.66.0/+esm";
let mbPromise = null;

export function getMediabunny() {
  return (mbPromise ??= import(LOCAL_MB_URL).catch(() => import(CDN_MB_URL)));
}

function isAudioMimeOrExt(file) {
  if (file.type?.startsWith("audio/")) return true;
  return /\.(mp3|wav|m4a|aac|ogg|flac|opus|weba|wma)$/i.test(file.name || "");
}

function nativeProbe(file) {
  return new Promise((resolve, reject) => {
    const isAudio = isAudioMimeOrExt(file);
    const el = document.createElement(isAudio ? "audio" : "video");
    const url = URL.createObjectURL(file);
    el.preload = "metadata";
    el.muted = true;
    const done = () => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      el.load();
    };
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      const width = isAudio ? 1080 : (el.videoWidth || 1080);
      const height = isAudio ? 1920 : (el.videoHeight || 1920);
      done();
      resolve({
        name: file.name,
        size: file.size,
        width,
        height,
        duration,
        fps: 30,
        hasAudio: true,
        isAudioOnly: isAudio || !el.videoWidth,
      });
    };
    el.onerror = () => {
      done();
      reject(new Error("Could not read this media file. Try MP4, MOV, WebM, MP3, WAV, M4A, OGG, or FLAC."));
    };
    el.src = url;
  });
}

export async function probeMedia(file) {
  try {
    const { ALL_FORMATS, BlobSource, Input } = await getMediabunny();
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack().catch(() => null);
      const audio = await input.getPrimaryAudioTrack().catch(() => null);
      const duration = await input.computeDuration().catch(() => 0);

      if (video && (await video.canDecode().catch(() => false))) {
        const [width, height, fps] = await Promise.all([
          video.getDisplayWidth(),
          video.getDisplayHeight(),
          video.computeFrameRateMetrics().then((m) => m.bestGuessFrameRate).catch(() => 30),
        ]);
        return {
          name: file.name,
          size: file.size,
          width: width || 1080,
          height: height || 1920,
          duration: duration || 0,
          fps: fps > 0 && fps <= 120 ? Math.round(fps * 100) / 100 : 30,
          hasAudio: !!audio && (await audio.canDecode().catch(() => false)),
          isAudioOnly: false,
        };
      }

      if (audio && (await audio.canDecode().catch(() => false))) {
        return {
          name: file.name,
          size: file.size,
          width: 1080,
          height: 1920,
          duration: duration || 0,
          fps: 30,
          hasAudio: true,
          isAudioOnly: true,
        };
      }
    } finally {
      input.dispose();
    }
  } catch {}
  return nativeProbe(file);
}

async function resampleBlock(block, rate) {
  if (rate === SPEECH_RATE) return block;
  const length = Math.max(1, Math.round((block.length * SPEECH_RATE) / rate));
  const offline = new OfflineAudioContext(1, length, SPEECH_RATE);
  const buffer = offline.createBuffer(1, block.length, rate);
  buffer.copyToChannel(block, 0);
  const node = offline.createBufferSource();
  node.buffer = buffer;
  node.connect(offline.destination);
  node.start();
  return (await offline.startRendering()).getChannelData(0);
}

function buildPeaks(samples) {
  const hop = SPEECH_RATE / PEAK_RATE;
  const peaks = new Float32Array(Math.ceil(samples.length / hop));
  for (let i = 0; i < peaks.length; i++) {
    let max = 0;
    const end = Math.min(samples.length, (i + 1) * hop);
    for (let j = i * hop; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

async function extractAudioNative(file, onProgress) {
  onProgress?.(0.15);
  const arrayBuf = await file.arrayBuffer();
  onProgress?.(0.45);
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuf);
    onProgress?.(0.75);
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i];
    }
    if (decoded.numberOfChannels > 1) {
      for (let i = 0; i < mono.length; i++) mono[i] /= decoded.numberOfChannels;
    }
    const samples = await resampleBlock(mono, decoded.sampleRate);
    const copy = new Float32Array(samples.length);
    copy.set(samples);
    onProgress?.(1);
    return { samples: copy, peaks: buildPeaks(copy), duration: decoded.duration };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function extractAudio(file, onProgress, signal) {
  try {
    const { ALL_FORMATS, AudioBufferSink, BlobSource, Input } = await getMediabunny();
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode().catch(() => false))) {
        throw new Error("NO_MEDIABUNNY_AUDIO");
      }
      const duration = Math.max(await input.computeDuration(), 0.1);
      const samples = new Float32Array(Math.ceil((duration + 0.5) * SPEECH_RATE));

      let parts = [];
      let partLength = 0;
      let blockStart = 0;
      let rate = 0;

      const flush = async () => {
        if (!partLength) return;
        const block = new Float32Array(partLength);
        let at = 0;
        for (const p of parts) {
          block.set(p, at);
          at += p.length;
        }
        const out = await resampleBlock(block, rate);
        const offset = Math.max(0, Math.round(blockStart * SPEECH_RATE));
        samples.set(out.subarray(0, Math.max(0, samples.length - offset)), Math.min(offset, samples.length));
        parts = [];
        partLength = 0;
      };

      for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        if (buffer.sampleRate !== rate || !partLength) {
          await flush();
          rate = buffer.sampleRate;
          blockStart = timestamp;
        }
        const mono = new Float32Array(buffer.length);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const data = buffer.getChannelData(c);
          for (let i = 0; i < data.length; i++) mono[i] += data[i];
        }
        if (buffer.numberOfChannels > 1) {
          for (let i = 0; i < mono.length; i++) mono[i] /= buffer.numberOfChannels;
        }
        parts.push(mono);
        partLength += mono.length;
        if (partLength >= rate * 20) await flush();
        onProgress?.(Math.min(1, (timestamp + buffer.duration) / duration));
      }
      await flush();
      return { samples, peaks: buildPeaks(samples), duration };
    } finally {
      input.dispose();
    }
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return extractAudioNative(file, onProgress);
  }
}

export function tightenWords(words, peaks) {
  if (!peaks || !peaks.length) return words;
  const sorted = Float32Array.from(peaks).sort();
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const threshold = Math.max(0.008, loud * 0.1);
  const minFrames = 3;
  const minLength = 0.14;
  const out = [];
  for (const word of words) {
    let a = Math.max(0, Math.floor(word.start * PEAK_RATE));
    let b = Math.min(peaks.length, Math.ceil(word.end * PEAK_RATE));
    while (b - a > minFrames && peaks[b - 1] < threshold) b--;
    while (b - a > minFrames && peaks[a] < threshold) a++;
    let start = Math.max(word.start, a / PEAK_RATE);
    const end = Math.min(word.end, b / PEAK_RATE);
    if (end - start < 0.05) {
      out.push(word);
      continue;
    }
    if (end - start < minLength) start = Math.max(out[out.length - 1]?.end ?? 0, end - minLength);
    out.push({ ...word, start, end });
  }
  return out;
}

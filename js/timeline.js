/**
 * CapStream — Timeline, Jump Cuts, Auto-Zoom, Subtitle Export (SRT/VTT/ASS/TXT) & Import
 */
import { pageEnd, pageStart, pageText, uid } from "./segment.js";

/* ------------------------------------------------------------------ Jump Cuts */
const PACES = {
  natural: { gap: 0.7, keep: 0.28 },
  fast: { gap: 0.42, keep: 0.16 },
  extra: { gap: 0.26, keep: 0.08 },
};

const cutCache = new WeakMap();

export function planCuts(pages, duration, pace = "fast") {
  if (!pages || !pages.length) return [];
  const key = `${pace}|${duration}`;
  const hit = cutCache.get(pages);
  if (hit?.key === key) return hit.cuts;

  const { gap, keep } = PACES[pace] || PACES.fast;
  const words = pages.flatMap((p) => p.words);
  const cuts = [];
  if (words.length) {
    const first = words[0];
    if (first.start > gap) cuts.push({ start: 0, end: first.start - keep });
    for (let i = 0; i < words.length - 1; i++) {
      const pause = words[i + 1].start - words[i].end;
      if (pause > gap) cuts.push({ start: words[i].end + keep / 2, end: words[i + 1].start - keep / 2 });
    }
    const last = words[words.length - 1];
    if (duration - last.end > gap) cuts.push({ start: last.end + keep, end: duration });
  }
  const clean = cuts.filter((c) => c.end - c.start > 0.05);
  cutCache.set(pages, { key, cuts: clean });
  return clean;
}

export function keptRanges(cuts, duration) {
  const kept = [];
  let at = 0;
  for (const cut of cuts) {
    if (cut.start > at) kept.push({ start: at, end: Math.min(cut.start, duration) });
    at = Math.max(at, cut.end);
  }
  if (at < duration) kept.push({ start: at, end: duration });
  return kept.filter((r) => r.end - r.start > 1e-4);
}

export function cutTotal(cuts, duration) {
  let total = 0;
  for (const cut of cuts) total += Math.max(0, Math.min(cut.end, duration) - cut.start);
  return total;
}

export function toOutputTime(cuts, t) {
  let removed = 0;
  for (const cut of cuts) {
    if (t <= cut.start) break;
    removed += Math.min(t, cut.end) - cut.start;
  }
  return t - removed;
}

export function toSourceTime(cuts, tOut) {
  let t = tOut;
  for (const cut of cuts) {
    if (cut.start <= t) t += cut.end - cut.start;
    else break;
  }
  return t;
}

export function skipTarget(cuts, t) {
  for (const cut of cuts) {
    if (t < cut.start - 0.001) return null;
    if (t < cut.end - 0.02) return cut.end;
  }
  return null;
}

export function formatTime(seconds) {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ Auto-Zoom */
const MIN_ZOOM_INTERVAL = 2.4;
const zoomCache = new WeakMap();

function planZoom(pages, intensity) {
  const hit = zoomCache.get(pages);
  if (hit?.intensity === intensity) return hit.keys;
  const levels = [1, 1.06 + 0.1 * intensity, 1, 1.1 + 0.16 * intensity];
  const keys = [{ t: -Infinity, z: 1 }];
  let last = -Infinity;
  let level = 0;
  for (const page of pages || []) {
    const t = pageStart(page);
    if (t - last < MIN_ZOOM_INTERVAL) continue;
    if (last !== -Infinity) {
      level = (level + 1) % levels.length;
      keys.push({ t, z: levels[level] });
    }
    last = t;
  }
  zoomCache.set(pages, { intensity, keys });
  return keys;
}

export function zoomAt(pages, zoom, t) {
  const keys = planZoom(pages, zoom.intensity);
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  if (!zoom.smooth || i === 0) return keys[i].z;
  const p = Math.min(1, (t - keys[i].t) / 0.3);
  const eased = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
  return keys[i - 1].z + (keys[i].z - keys[i - 1].z) * eased;
}

/* ------------------------------------------------------------------ Subtitles */
function stamp(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

function assStamp(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs / 6000) % 60);
  const s = Math.floor((cs / 100) % 60);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function cues(pages, offset, cuts) {
  return (pages || [])
    .filter((p) => p.words.length > 0 && skipTarget(cuts, pageStart(p)) === null)
    .map((p) => ({
      start: Math.max(0, toOutputTime(cuts, pageStart(p) + offset)),
      end: Math.max(0, toOutputTime(cuts, pageEnd(p) + offset)),
      text: pageText(p),
    }))
    .filter((c) => c.end > c.start);
}

export function toSrt(pages, offset = 0, cuts = []) {
  return cues(pages, offset, cuts)
    .map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(pages, offset = 0, cuts = []) {
  return `WEBVTT\n\n${cues(pages, offset, cuts)
    .map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`)
    .join("\n")}`;
}

export function toAss(pages, style, offset = 0, cuts = []) {
  const hexToAss = (hex) => {
    const clean = (hex || "#FFFFFF").replace("#", "");
    if (clean.length !== 6) return "&H00FFFFFF";
    const r = clean.slice(0, 2), g = clean.slice(2, 4), b = clean.slice(4, 6);
    return `&H00${b}${g}${r}`.toUpperCase();
  };
  const header = `[Script Info]
Title: CapStream Captions (Powered by Unskyit)
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style?.font || "Montserrat"},72,${hexToAss(style?.color)},${hexToAss(style?.activeColor || "#FFE600")},${hexToAss(style?.stroke?.color || "#000000")},&H80000000,-1,${style?.italic ? -1 : 0},0,0,100,100,0,0,1,4,2,2,40,40,240,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const lines = cues(pages, offset, cuts).map(
    (c) => `Dialogue: 0,${assStamp(c.start)},${assStamp(c.end)},Default,,0,0,0,,${c.text.replace(/\n/g, "\\N")}`
  );
  return header + lines.join("\n") + "\n";
}

export function toPlainText(pages) {
  return (pages || []).map(pageText).join(" ");
}

/** Parse uploaded .srt or .vtt file into word-level RawWords */
export function parseSubtitles(content) {
  const blocks = String(content || "").replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const words = [];
  const timeRe = /(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})/;
  const parseT = (h, m, s, ms) => (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const tIdx = lines.findIndex((l) => timeRe.test(l));
    if (tIdx < 0) continue;
    const m = timeRe.exec(lines[tIdx]);
    if (!m) continue;
    const start = parseT(m[1], m[2], m[3], m[4]);
    const end = parseT(m[5], m[6], m[7], m[8]);
    const text = lines.slice(tIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length || end <= start) continue;
    const weights = tokens.map((tk) => tk.length + 1.5);
    const totalW = weights.reduce((a, b) => a + b, 0);
    let t = start;
    for (let i = 0; i < tokens.length; i++) {
      const dur = ((weights[i] / totalW) * (end - start));
      words.push({ id: uid("w"), text: tokens[i], start: t, end: t + dur });
      t += dur;
    }
  }
  return words;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

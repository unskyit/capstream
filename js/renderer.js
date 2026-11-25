/**
 * CapStream — Unified Canvas 2D Renderer (Live Preview + Transparent/Video Export)
 * Powered by Unskyit
 */
import { fontEpoch, fontString } from "./fonts.js";
import { displayText, emojiPicker, needsSpace, pageEnd, pageStart } from "./segment.js";
import { planCuts, zoomAt } from "./timeline.js";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const cubicOut = (p) => 1 - (1 - p) ** 3;
const backOut = (p) => 1 + 2.9 * (p - 1) ** 3 + 1.9 * (p - 1) ** 2;
const bounceOut = (p) => {
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
};

export const DEFAULT_FX = {
  emoji: { enabled: false, size: 1.4 },
  hook: { enabled: false, text: "", duration: 3, color: "#FFFFFF", background: "#2563EB" },
  progress: { enabled: false, color: "#3B82F6", position: "bottom" },
  zoom: { enabled: false, intensity: 0.5, smooth: true },
  cuts: { enabled: false, pace: "fast" },
};

export const DEFAULT_FRAME = {
  aspect: "source",
  fit: "cover", // cover | blur | contain
  panX: 0,
  panY: 0,
  bgMode: "video", // video | transparent | chroma-green | chroma-blue | solid | gradient | waveform
  bgColor: "#0A0F1E",
  bgColor2: "#1E3A8A",
  waveformColor: "#3B82F6",
};

export function cutsFor(doc, duration) {
  return doc?.fx?.cuts?.enabled ? planCuts(doc.pages, duration, doc.fx.cuts.pace) : [];
}

const RATIOS = { "9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "16:9": 16 / 9 };

export function aspectRatio(meta, aspect) {
  if (aspect === "source") {
    if (meta?.isAudioOnly || !meta?.width || !meta?.height) return 9 / 16;
    return meta.width / Math.max(1, meta.height);
  }
  return RATIOS[aspect] || 9 / 16;
}

export function frameSize(meta, aspect, shortSide = 1080) {
  const ratio = aspectRatio(meta, aspect);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return ratio <= 1
    ? { width: even(shortSide), height: even(shortSide / ratio) }
    : { width: even(shortSide * ratio), height: even(shortSide) };
}

/* ------------------------------------------------------------------ Timing */
const LINGER = 0.35;
const BRIDGE = 0.9;
const timelines = new WeakMap();

function getTimeline(pages) {
  let tl = timelines.get(pages);
  if (!tl) {
    const n = pages.length;
    tl = { starts: new Float64Array(n), ends: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      tl.starts[i] = pageStart(pages[i]);
      const last = pageEnd(pages[i]);
      const next = i + 1 < n ? pageStart(pages[i + 1]) : Infinity;
      tl.ends[i] = next - last <= BRIDGE ? next : last + LINGER;
    }
    timelines.set(pages, tl);
  }
  return tl;
}

export function activePageIndex(pages, t) {
  if (!pages || !pages.length) return -1;
  const { starts, ends } = getTimeline(pages);
  let lo = 0, hi = starts.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t < ends[found] ? found : -1;
}

/* ------------------------------------------------------------------ Layout */
const layouts = new WeakMap();

function setFont(ctx, style, px) {
  ctx.font = fontString(style.font, style.weight, style.italic, px);
  if ("letterSpacing" in ctx) {
    try {
      ctx.letterSpacing = `${(style.tracking * px).toFixed(2)}px`;
    } catch {
      // Ignore unsupported letterSpacing
    }
  }
}

function partition(widths, gaps, count) {
  const n = widths.length;
  const prefix = [0];
  for (let i = 0; i < n; i++) prefix.push(prefix[i] + widths[i] + (i > 0 ? gaps[i] : 0));
  const span = (a, b) => prefix[b] - prefix[a] - (a > 0 ? gaps[a] : 0);
  const best = (a, k) => {
    if (k === 1) return { breaks: [a], widest: span(a, n) };
    let out = { breaks: [a], widest: Infinity };
    for (let b = a + 1; b <= n - (k - 1); b++) {
      const rest = best(b, k - 1);
      const widest = Math.max(span(a, b), rest.widest);
      if (widest < out.widest) out = { breaks: [a, ...rest.breaks], widest };
    }
    return out;
  };
  return best(0, Math.min(count, n));
}

function layoutPage(ctx, page, style, W, H) {
  const ep = fontEpoch();
  const hit = layouts.get(page);
  if (hit && hit.style === style && hit.W === W && hit.H === H && hit.epoch === ep) return hit;

  const texts = page.words.map((w) => displayText(w.text, style.textCase, style.punctuation));
  const maxW = style.maxWidth * W;
  let px = (style.size / 100) * Math.min(W, H);
  let widths = [], gaps = [], fit = { breaks: [0], widest: 0 };

  for (let attempt = 0; attempt < 14; attempt++) {
    setFont(ctx, style, px);
    const space = ctx.measureText(" ").width;
    widths = texts.map((t) => ctx.measureText(t).width);
    gaps = texts.map((t, i) => (i > 0 && needsSpace(texts[i - 1], t) ? space : 0));
    for (let k = 1; k <= Math.max(1, style.maxLines); k++) {
      fit = partition(widths, gaps, k);
      if (fit.widest <= maxW) break;
    }
    if (fit.widest <= maxW) break;
    px *= 0.92;
  }

  const metrics = ctx.measureText("H");
  const capRatio = (metrics.actualBoundingBoxAscent || px * 0.7) / px;
  const target = Math.min(maxW, fit.widest);
  const specs = fit.breaks.map((a, i) => {
    const b = fit.breaks[i + 1] ?? texts.length;
    let w = 0;
    for (let j = a; j < b; j++) w += widths[j] + (j > a ? gaps[j] : 0);
    const scale = style.fitLines && w > 0 ? clamp(target / w, 0.55, 2.6) : 1;
    return { a, b, w: w * scale, scale };
  });

  const blockW = Math.max(...specs.map((s) => s.w));
  const blockH = specs.reduce((sum, s) => sum + px * s.scale * style.leading, 0);
  const margin = H * 0.04;
  const cy = clamp(style.y * H, blockH / 2 + margin, H - blockH / 2 - margin);

  const lines = [];
  const words = [];
  let top = cy - blockH / 2;
  specs.forEach((s, li) => {
    const lpx = px * s.scale;
    const h = lpx * style.leading;
    const mid = top + h / 2;
    const x0 = (W - s.w) / 2;
    lines.push({ x: x0, w: s.w, top, h, mid, baseline: mid + (capRatio * lpx) / 2, px: lpx });
    let x = x0;
    for (let j = s.a; j < s.b; j++) {
      if (j > s.a) x += gaps[j] * s.scale;
      const w = widths[j] * s.scale;
      words.push({ word: page.words[j], text: texts[j], x, w, line: li });
      x += w;
    }
    top += h;
  });

  const layout = { words, lines, x: (W - blockW) / 2, y: cy - blockH / 2, w: blockW, h: blockH, cx: W / 2, cy, px, style, W, H, epoch: ep };
  layouts.set(page, layout);
  return layout;
}

/* ------------------------------------------------------------------ Animation */
const STILL = { a: 1, s: 1, dx: 0, dy: 0 };
const DURATION = { none: 0, pop: 0.16, fade: 0.14, rise: 0.18, drop: 0.34, zoom: 0.16, slide: 0.16 };

function entrance(kind, elapsed, index) {
  const d = DURATION[kind] || 0;
  if (!d || elapsed >= d) return STILL;
  const p = clamp01(elapsed / d);
  switch (kind) {
    case "pop": return { a: Math.min(1, p * 2.5), s: 0.7 + 0.3 * backOut(p), dx: 0, dy: 0 };
    case "fade": return { a: p, s: 1, dx: 0, dy: 0 };
    case "rise": return { a: p, s: 1, dx: 0, dy: (1 - cubicOut(p)) * 0.45 };
    case "drop": return { a: Math.min(1, p * 3), s: 1, dx: 0, dy: -(1 - bounceOut(p)) * 0.9 };
    case "zoom": return { a: Math.min(1, p * 2), s: 1.5 - 0.5 * cubicOut(p), dx: 0, dy: 0 };
    case "slide": return { a: Math.min(1, p * 2), s: 1, dx: (1 - cubicOut(p)) * 1.1 * (index % 2 ? 1 : -1), dy: 0 };
    default: return STILL;
  }
}

function plate(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  ctx.fill();
}

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export function drawCaptions(ctx, W, H, t, pages, style, emojiFn, emojiSize = 1.4) {
  const index = activePageIndex(pages, t);
  if (index < 0 || !pages[index]?.words?.length) return;
  const L = layoutPage(ctx, pages[index], style, W, H);
  const start = L.words[0].word.start;
  let active = 0;
  for (let i = 0; i < L.words.length; i++) {
    if (L.words[i].word.start <= t) active = i;
    else break;
  }
  const activeStart = L.words[active].word.start;
  const perWord = style.entranceScope === "word";
  const pageMotion = perWord ? STILL : entrance(style.entrance, t - start, index);

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.translate(L.cx + pageMotion.dx * L.px, L.cy + pageMotion.dy * L.px);
  if (style.tilt) ctx.rotate(((style.tilt * Math.PI) / 180) * (index % 2 ? -1 : 1));
  if (pageMotion.s !== 1) ctx.scale(pageMotion.s, pageMotion.s);
  ctx.translate(-L.cx, -L.cy);

  if (style.box) {
    const b = style.box;
    ctx.globalAlpha = pageMotion.a;
    ctx.fillStyle = b.color;
    if (b.scope === "page") {
      plate(ctx, L.x - b.padX * L.px, L.y - b.padY * L.px, L.w + 2 * b.padX * L.px, L.h + 2 * b.padY * L.px, b.radius * L.px);
    } else {
      for (const line of L.lines) {
        const h = line.px * (1.08 + 2 * b.padY);
        plate(ctx, line.x - b.padX * line.px, line.mid - h / 2, line.w + 2 * b.padX * line.px, h, b.radius * line.px);
      }
    }
  }

  if (style.activeBox) {
    const b = style.activeBox;
    const rect = (i) => {
      const w = L.words[i];
      const line = L.lines[w.line];
      const h = line.px * (1.04 + 2 * b.padY);
      return { x: w.x - b.padX * line.px, y: line.mid - h / 2, w: w.w + 2 * b.padX * line.px, h, r: b.radius * line.px };
    };
    const to = rect(active);
    const k = cubicOut(clamp01((t - activeStart) / 0.1));
    const from = active > 0 ? rect(active - 1) : to;
    ctx.globalAlpha = pageMotion.a * (active > 0 ? 1 : k);
    ctx.fillStyle = b.color;
    plate(ctx, from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.w + (to.w - from.w) * k, from.h + (to.h - from.h) * k, to.r);
  }

  const looks = L.words.map((w, i) => {
    const state = i < active ? "spoken" : i === active ? "active" : "upcoming";
    let alpha = state === "upcoming" ? style.upcomingOpacity : 1;
    let motion = STILL;
    if (perWord && state !== "upcoming") {
      motion = entrance(style.entrance, t - w.word.start, i);
      alpha *= motion.a;
    }
    let scale = motion.s;
    if (style.activeScale !== 1) {
      const grow = style.activeScale - 1;
      if (state === "active") scale *= 1 + grow * cubicOut(clamp01((t - w.word.start) / 0.09));
      else if (i === active - 1) scale *= 1 + grow * (1 - clamp01((t - activeStart) / 0.09));
    }
    let color = style.color;
    if (w.word.emphasis && style.emphasisColor) color = style.emphasisColor;
    if (state === "spoken" && style.spokenColor) color = style.spokenColor;
    if (state === "active" && style.activeColor && style.fill !== "sweep") color = style.activeColor;
    return { state, alpha: alpha * pageMotion.a, scale, dx: motion.dx, dy: motion.dy, color };
  });

  const each = (fn) => {
    L.words.forEach((w, i) => {
      const look = looks[i];
      if (look.alpha <= 0.004) return;
      const line = L.lines[w.line];
      ctx.save();
      ctx.globalAlpha = look.alpha;
      if (look.scale !== 1 || look.dx || look.dy) {
        const cx = w.x + w.w / 2;
        ctx.translate(cx + look.dx * line.px, line.mid + look.dy * line.px);
        ctx.scale(look.scale, look.scale);
        ctx.translate(-cx, -line.mid);
      }
      setFont(ctx, style, line.px);
      fn(w, line, look);
      ctx.restore();
    });
  };

  const applyShadow = (px) => {
    if (!style.shadow) return;
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * px;
    ctx.shadowOffsetX = style.shadow.x * px;
    ctx.shadowOffsetY = style.shadow.y * px;
  };

  if (style.stroke && style.stroke.width > 0) {
    each((w, line) => {
      applyShadow(line.px);
      ctx.strokeStyle = style.stroke.color;
      ctx.lineWidth = style.stroke.width * line.px * 2;
      ctx.strokeText(w.text, w.x, line.baseline);
    });
  }

  each((w, line, look) => {
    if (style.glitch) {
      const jolt = 0.035 + 0.07 * Math.max(0, 1 - (t - start) / 0.14) * Math.abs(Math.sin(t * 97));
      ctx.fillStyle = "#00F0FF";
      ctx.fillText(w.text, w.x - jolt * line.px, line.baseline);
      ctx.fillStyle = "#FF2D95";
      ctx.fillText(w.text, w.x + jolt * line.px, line.baseline + jolt * 0.4 * line.px);
    }
    if (!style.stroke) applyShadow(line.px);
    if (style.gradient) {
      const g = ctx.createLinearGradient(0, line.mid - line.px * 0.45, 0, line.mid + line.px * 0.45);
      g.addColorStop(0, style.gradient[0]);
      g.addColorStop(1, style.gradient[1]);
      ctx.fillStyle = look.state === "active" && style.activeColor ? look.color : g;
    } else {
      ctx.fillStyle = look.color;
    }
    ctx.fillText(w.text, w.x, line.baseline);

    if (style.fill === "sweep" && look.state === "active" && style.activeColor) {
      const span = Math.max(0.05, w.word.end - w.word.start);
      ctx.shadowColor = "transparent";
      ctx.beginPath();
      ctx.rect(w.x - line.px * 0.1, line.top - line.px, (w.w + line.px * 0.2) * clamp01((t - w.word.start) / span), line.h + line.px * 2);
      ctx.clip();
      ctx.fillStyle = style.activeColor;
      ctx.fillText(w.text, w.x, line.baseline);
    }
  });

  const current = L.words[active];
  const currentLine = L.lines[current.line];
  if (style.underline) {
    const grow = cubicOut(clamp01((t - activeStart) / 0.12));
    ctx.globalAlpha = pageMotion.a;
    ctx.strokeStyle = style.underline.color;
    ctx.lineWidth = style.underline.thickness * currentLine.px;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(current.x, currentLine.baseline + currentLine.px * 0.16);
    ctx.lineTo(current.x + current.w * grow, currentLine.baseline + currentLine.px * 0.13);
    ctx.stroke();
  }
  if (style.cursor && (t * 2.2) % 1 < 0.6) {
    ctx.globalAlpha = pageMotion.a;
    ctx.fillStyle = style.activeColor ?? style.color;
    ctx.fillRect(current.x + current.w + currentLine.px * 0.14, currentLine.mid - currentLine.px * 0.42, currentLine.px * 0.5, currentLine.px * 0.84);
  }

  const glyph = emojiFn?.(index);
  if (glyph) {
    const size = emojiSize * L.px;
    const pad = style.box ? style.box.padY * L.px : 0;
    const above = L.y - pad - size * 0.62;
    const y = above - size / 2 > H * 0.03 ? above : L.y + L.h + pad + size * 0.62;
    const pop = backOut(clamp01((t - start) / 0.22));
    ctx.globalAlpha = Math.min(1, (t - start) / 0.08);
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = size * 0.12;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = size * 0.04;
    ctx.font = `${(size * (0.6 + 0.4 * pop)).toFixed(1)}px ${EMOJI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(glyph, L.cx, y);
  }
  ctx.restore();
}

export function drawHook(ctx, W, H, tOut, hook, style) {
  const text = (hook?.text || "").trim();
  if (!hook?.enabled || !text || tOut < 0 || tOut >= hook.duration) return;
  const px = Math.min(W, H) * 0.056;
  ctx.save();
  ctx.font = fontString(style.font, style.weight, false, px);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > W * 0.78) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);

  const lineH = px * 1.5;
  const fadeOut = clamp01((hook.duration - tOut) / 0.25);
  const pop = backOut(clamp01(tOut / 0.22));
  const cy = H * 0.16 + (lines.length * lineH) / 2;
  ctx.translate(W / 2, cy);
  ctx.scale(0.8 + 0.2 * pop, 0.8 + 0.2 * pop);
  ctx.translate(-W / 2, -cy);
  ctx.globalAlpha = Math.min(1, tOut / 0.1) * fadeOut;
  lines.forEach((l, i) => {
    const y = H * 0.16 + lineH * (i + 0.5);
    const w = ctx.measureText(l).width + px * 1.1;
    ctx.fillStyle = hook.background;
    plate(ctx, W / 2 - w / 2, y - lineH * 0.47, w, lineH * 0.94, px * 0.28);
    ctx.fillStyle = hook.color;
    ctx.fillText(l, W / 2, y + px * 0.04);
  });
  ctx.restore();
}

export function drawProgress(ctx, W, H, ratio, bar) {
  if (!bar?.enabled) return;
  const h = Math.max(4, Math.round(Math.min(W, H) * 0.011));
  const y = bar.position === "top" ? 0 : H - h;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(0, y, W, h);
  ctx.fillStyle = bar.color;
  ctx.fillRect(0, y, W * clamp01(ratio), h);
  ctx.restore();
}

/* ------------------------------------------------------------------ Audio Waveform Backdrop */
function drawWaveformBackdrop(ctx, W, H, tSource, peaks, frame) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, frame.bgColor || "#0A0F1E");
  g.addColorStop(1, frame.bgColor2 || "#1E3A8A");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  if (!peaks || !peaks.length) return;
  const bars = 44;
  const idxCenter = Math.floor(tSource * 50);
  const barW = (W * 0.72) / bars;
  const startX = W * 0.14;
  const cy = H * 0.38;
  const maxBarH = H * 0.22;

  ctx.save();
  ctx.fillStyle = frame.waveformColor || "#3B82F6";
  for (let i = 0; i < bars; i++) {
    const pIdx = clamp(idxCenter + (i - Math.floor(bars / 2)) * 2, 0, peaks.length - 1);
    const amp = Math.max(0.06, Math.min(1, (peaks[pIdx] || 0) * 1.4));
    const h = amp * maxBarH;
    const x = startX + i * barW + barW * 0.2;
    const w = barW * 0.6;
    ctx.globalAlpha = i === Math.floor(bars / 2) ? 1 : 0.45 + 0.4 * (1 - Math.abs(i - bars / 2) / (bars / 2));
    plate(ctx, x, cy - h / 2, w, h, w / 2);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ Video Drawing */
let scratch = null;

function drawCover(ctx, src, W, H, panX, panY, zoom) {
  const base = Math.max(W / src.width, H / src.height);
  const bw = W / base;
  const bh = H / base;
  const bx = (src.width - bw) * (0.5 + clamp(panX, -1, 1) / 2);
  const by = (src.height - bh) * (0.5 + clamp(panY, -1, 1) / 2);
  const sw = bw / zoom;
  const sh = bh / zoom;
  src.draw(ctx, bx + (bw - sw) * 0.5, by + (bh - sh) * 0.42, sw, sh, 0, 0, W, H);
}

export function drawVideo(ctx, src, W, H, frame, zoom) {
  if (!src?.width || !src?.height) return;
  const sameShape = Math.abs(src.width / src.height - W / H) < 0.01;
  if (frame.fit === "contain") {
    const scale = Math.min(W / src.width, H / src.height) * zoom;
    const dw = src.width * scale;
    const dh = src.height * scale;
    src.draw(ctx, 0, 0, src.width, src.height, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return;
  }
  if (frame.fit !== "blur" || sameShape) {
    drawCover(ctx, src, W, H, frame.panX, frame.panY, zoom);
    return;
  }
  const bw = 48;
  const bh = Math.max(8, Math.round((bw * H) / W));
  if (!scratch) scratch = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bw, bh) : document.createElement("canvas");
  if (scratch.width !== bw || scratch.height !== bh) {
    scratch.width = bw;
    scratch.height = bh;
  }
  drawCover(scratch.getContext("2d"), src, bw, bh, 0, 0, 1.1);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if ("filter" in ctx) ctx.filter = `blur(${Math.round(Math.min(W, H) * 0.02)}px)`;
  ctx.drawImage(scratch, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1);
  if ("filter" in ctx) ctx.filter = "none";
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  const scale = Math.min(W / src.width, H / src.height) * zoom;
  const dw = src.width * scale;
  const dh = src.height * scale;
  src.draw(ctx, 0, 0, src.width, src.height, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/**
 * Renders one complete frame.
 * Supports true transparent alpha (`bgMode === "transparent"` or `forceTransparent === true`).
 */
export function renderScene(ctx, source, W, H, tSource, tOutput, outDuration, doc, opts = {}) {
  const bgMode = opts.forceBgMode || doc.frame.bgMode || "video";

  if (bgMode === "transparent") {
    ctx.clearRect(0, 0, W, H);
  } else if (bgMode === "chroma-green") {
    ctx.fillStyle = "#00FF00";
    ctx.fillRect(0, 0, W, H);
  } else if (bgMode === "chroma-blue") {
    ctx.fillStyle = "#0000FF";
    ctx.fillRect(0, 0, W, H);
  } else if (bgMode === "solid") {
    ctx.fillStyle = doc.frame.bgColor || "#0A0F1E";
    ctx.fillRect(0, 0, W, H);
  } else if (bgMode === "gradient") {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, doc.frame.bgColor || "#0A0F1E");
    g.addColorStop(1, doc.frame.bgColor2 || "#1E3A8A");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else if (bgMode === "waveform") {
    drawWaveformBackdrop(ctx, W, H, tSource, opts.peaks, doc.frame);
  } else {
    ctx.fillStyle = "#050811";
    ctx.fillRect(0, 0, W, H);
    if (source) {
      drawVideo(ctx, source, W, H, doc.frame, doc.fx.zoom.enabled ? zoomAt(doc.pages, doc.fx.zoom, tSource) : 1);
    }
  }

  drawProgress(ctx, W, H, outDuration > 0 ? tOutput / outDuration : 0, doc.fx.progress);
  drawHook(ctx, W, H, tOutput, doc.fx.hook, doc.style);
  drawCaptions(
    ctx,
    W,
    H,
    tSource - (doc.offset || 0),
    doc.pages,
    doc.style,
    doc.fx.emoji.enabled ? emojiPicker(doc.pages) : undefined,
    doc.fx.emoji.size,
  );
}

/**
 * CapStream — Word Normalization, Segmentation & Auto-Emoji Engine
 */

let counter = 0;
export function uid(prefix = "w") {
  counter = (counter + 1) % 0xffffff;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

const NO_SPACE_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0e00-\u0e7f\u1000-\u109f\u0e80-\u0eff]/;

export function needsSpace(before, after) {
  if (!before || !after) return false;
  return !(NO_SPACE_SCRIPT.test(before.slice(-1)) && NO_SPACE_SCRIPT.test(after[0]));
}

export function joinWords(texts) {
  let out = "";
  for (let i = 0; i < texts.length; i++) {
    if (i > 0 && needsSpace(texts[i - 1], texts[i])) out += " ";
    out += texts[i];
  }
  return out;
}

export function pageStart(page) {
  return page?.words?.[0]?.start ?? 0;
}

export function pageEnd(page) {
  return page?.words?.[page.words.length - 1]?.end ?? 0;
}

export function pageText(page) {
  return joinWords((page?.words || []).map((w) => w.text));
}

const PAUSE_BREAK = 0.6;
const SENTENCE_END = /[.!?…。！？]["'”’)]*$/;
const CLAUSE_END = /[,;:，、；：]["'”’)]*$/;
const MIN_WORD = 0.05;

export function normalizeWords(raw, duration) {
  const limit = duration > 0 ? duration : Infinity;
  const words = (raw || [])
    .map((w) => ({ ...w, id: w.id || uid("w"), text: String(w.text || "").trim() }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.start))
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    w.start = Math.max(0, Math.min(w.start, limit));
    if (!Number.isFinite(w.end) || w.end <= w.start) w.end = w.start + 0.25;
    if (i > 0) {
      const prev = words[i - 1];
      if (w.start < prev.start + MIN_WORD) w.start = prev.start + MIN_WORD;
      if (prev.end > w.start) prev.end = w.start;
    }
    if (w.end < w.start + MIN_WORD) w.end = w.start + MIN_WORD;
    if (w.end - w.start > 1.6) w.end = w.start + Math.min(1.6, 0.25 + w.text.length * 0.09);
    w.end = Math.min(w.end, limit);
    if (w.end <= w.start) w.start = Math.max(0, w.end - MIN_WORD);
  }
  return words;
}

function balancedSizes(n, size) {
  const groups = Math.ceil(n / size);
  const base = Math.floor(n / groups);
  let extra = n % groups;
  const sizes = [];
  for (let i = 0; i < groups; i++) {
    sizes.push(base + (extra > 0 ? 1 : 0));
    extra--;
  }
  return sizes;
}

function charLength(words) {
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    n += words[i].text.length;
    if (i > 0 && needsSpace(words[i - 1].text, words[i].text)) n++;
  }
  return n;
}

function splitByChars(group, maxChars) {
  if (group.length <= 1 || charLength(group) <= maxChars) return [group];
  const mid = Math.ceil(group.length / 2);
  return [...splitByChars(group.slice(0, mid), maxChars), ...splitByChars(group.slice(mid), maxChars)];
}

export function segmentWords(words, options = {}) {
  const perPage = Math.max(1, Math.round(options.wordsPerPage || 3));
  const maxChars = options.maxChars ?? Math.max(14, perPage * 9);
  const phrases = [];
  let current = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);
    const next = words[i + 1];
    const pause = next ? next.start - word.end : Infinity;
    const clauseBreak = CLAUSE_END.test(word.text) && current.length >= Math.min(perPage, 2) && perPage > 1;
    if (!next || pause >= PAUSE_BREAK || SENTENCE_END.test(word.text) || (clauseBreak && pause >= 0.18)) {
      phrases.push(current);
      current = [];
    }
  }
  if (current.length) phrases.push(current);

  const pages = [];
  for (const phrase of phrases) {
    let cursor = 0;
    for (const size of balancedSizes(phrase.length, perPage)) {
      const group = phrase.slice(cursor, cursor + size);
      cursor += size;
      for (const part of splitByChars(group, maxChars)) {
        pages.push({ id: uid("p"), words: part });
      }
    }
  }
  return pages;
}

export function resegment(pages, options) {
  return segmentWords((pages || []).flatMap((p) => p.words), options);
}

export function retimeWords(page, text) {
  const tokens = String(text || "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  if (tokens.length === page.words.length) {
    return page.words.map((w, i) => ({ ...w, text: tokens[i] }));
  }
  const start = page.words[0]?.start ?? 0;
  const end = page.words[page.words.length - 1]?.end ?? start + 1;
  const weights = tokens.map((t) => t.length + 1.5);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(end - start, tokens.length * MIN_WORD);
  let t = start;
  return tokens.map((token, i) => {
    const length = (weights[i] / total) * span;
    const word = { id: uid("w"), text: token, start: t, end: t + length };
    t += length;
    return word;
  });
}

const TRIM_PUNCTUATION = /^[\s"“”‘’«»(\[]+|[\s.,!?;:…"“”’»)\]。，、！？；：]+$/g;

export function displayText(text, textCase, punctuation) {
  let out = String(text || "");
  if (!punctuation) {
    const stripped = out.replace(TRIM_PUNCTUATION, "");
    if (stripped.length > 0) out = stripped;
  }
  if (textCase === "upper") return out.toLocaleUpperCase();
  if (textCase === "lower") return out.toLocaleLowerCase();
  return out;
}

/* ------------------------------------------------------------------ Auto Emoji */
const EMOJI_RULES = `
💰 money cash dollar dollars rich wealth wealthy paid pay profit profits revenue income salary million millions billion
🔥 fire hot viral lit crazy insane wild trending
🧠 brain think thinking mind smart learn learning idea ideas knowledge psychology
⏰ time clock minutes hours late early deadline fast quick
❤️ love heart loved loving favorite
😂 funny laugh laughing hilarious joke lol
😱 shocked shocking scary terrifying unbelievable
🚀 launch launched grow growth growing scale rocket startup faster boost
📈 increase increased sales chart stocks market up views subscribers
📉 decrease drop dropped crash crashed down lost
🎯 goal goals target focus exactly precise
💡 tip tips trick tricks hack hacks secret secrets
👀 look watch see saw seen eyes notice
🎬 video videos film edit editing content clip clips youtube shorts reels
📱 phone iphone app apps tiktok instagram mobile scroll scrolling
💻 computer laptop code coding software website online browser
🎵 music song songs sound audio beat podcast voice
📚 book books read reading study studying school college
💪 strong strength gym workout muscle power fitness
🏆 win winner winning won best champion success successful
❌ wrong mistake mistakes never stop bad worst fail failed failure
✅ right correct yes done finished perfect
⚠️ warning careful danger dangerous risk
🤔 why how question wonder maybe
🙏 thank thanks please grateful
🎉 party celebrate congrats congratulations birthday
☕ coffee morning breakfast
🌍 world earth global country countries travel
👑 king queen boss legend
💎 value valuable premium quality luxury diamond
🤝 deal partner partners team together
🆓 free
🤯 mindblowing genius incredible
😎 cool easy
👇 below here link comment comments
`;

const EMOJI_LOOKUP = new Map();
for (const line of EMOJI_RULES.trim().split("\n")) {
  const [glyph, ...keywords] = line.trim().split(/\s+/);
  for (const k of keywords) EMOJI_LOOKUP.set(k, glyph);
}

function matchEmoji(page) {
  for (const word of page.words) {
    const key = word.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const hit = EMOJI_LOOKUP.get(key) ?? (key.endsWith("s") ? EMOJI_LOOKUP.get(key.slice(0, -1)) : undefined);
    if (hit) return hit;
  }
  return null;
}

const emojiCache = new WeakMap();

export function emojiPicker(pages) {
  let picks = emojiCache.get(pages);
  if (!picks) {
    picks = [];
    let lastGlyph = null;
    let lastAuto = -2;
    for (let i = 0; i < pages.length; i++) {
      const manual = pages[i].emoji;
      if (manual !== undefined) {
        picks.push(manual || null);
        continue;
      }
      const auto = matchEmoji(pages[i]);
      if (auto && auto !== lastGlyph && i - lastAuto > 1) {
        picks.push(auto);
        lastGlyph = auto;
        lastAuto = i;
      } else {
        picks.push(null);
      }
    }
    emojiCache.set(pages, picks);
  }
  const resolved = picks;
  return (index) => resolved[index] ?? null;
}

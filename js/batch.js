/**
 * CapStream — Batch Queue Processor, Client Presets & Vocabulary Replacements
 * Powered by Unskyit
 */
import { idbGet, idbSet } from "./store.js";
import { uid } from "./segment.js";

const PRESETS_KEY = "client-presets-v1";

export async function readPresets() {
  return (await idbGet(PRESETS_KEY)) || [];
}

export async function savePresets(presets) {
  await idbSet(PRESETS_KEY, presets);
}

export function parseVocabulary(text) {
  const dict = new Map();
  for (const [idx, line] of String(text || "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const split = line.indexOf("=");
    const from = line.slice(0, split).trim();
    const to = line.slice(split + 1).trim();
    if (split < 1 || !from || !to) {
      throw new Error(`Vocabulary line ${idx + 1} must use the format: wrong = Right`);
    }
    dict.set(from.normalize("NFKC").toLowerCase(), to);
  }
  return dict;
}

export function applyVocabulary(pages, dict) {
  if (!dict || !dict.size) return pages;
  return pages.map((page) => ({
    ...page,
    words: page.words.map((word) => {
      const m = /^([^\p{L}\p{N}\p{M}]*)([\p{L}\p{N}](?:.*[\p{L}\p{N}\p{M}])?)([^\p{L}\p{N}\p{M}]*)$/u.exec(word.text);
      if (!m) return word;
      const rep = dict.get(m[2].normalize("NFKC").toLowerCase());
      return rep === undefined ? word : { ...word, text: m[1] + rep + m[3] };
    }),
  }));
}

export function createBatchItem(file) {
  return {
    id: uid("b"),
    file,
    name: file.name,
    size: file.size,
    status: "queued", // queued | processing | ready | exporting | done | error
    percent: 0,
    detail: "Queued",
    meta: null,
    peaks: null,
    doc: null,
    error: null,
  };
}

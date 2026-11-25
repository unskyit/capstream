/**
 * CapStream — Local Font Loader (Powered by Unskyit)
 * Loads bundled .woff2 fonts directly from ./fonts/ with zero external requests.
 */

const FALLBACK = 'system-ui, -apple-system, "Segoe UI", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

let families = {};
let manifestPromise = null;
const registered = new Set();
const listeners = new Set();
let epoch = 0;

export const DEFAULT_FONT_NAMES = [
  "Montserrat", "Inter", "Poppins", "Anton", "Bebas Neue", "Bangers",
  "Playfair Display", "Space Mono", "Archivo Black", "Fredoka",
  "Permanent Marker", "Oswald", "Rubik", "DM Sans", "Luckiest Guy", "Unbounded"
];

export async function loadFontManifest() {
  if (manifestPromise) return manifestPromise;
  manifestPromise = fetch("./fonts/font-manifest.json")
    .then((r) => (r.ok ? r.json() : {}))
    .then((data) => {
      families = data || {};
      return families;
    })
    .catch(() => {
      families = {};
      return families;
    });
  return manifestPromise;
}

export function getFontNames() {
  const keys = Object.keys(families);
  return keys.length ? keys : DEFAULT_FONT_NAMES;
}

export function weightsFor(font) {
  return families[font]?.weights ?? [400, 700, 800, 900];
}

export function fontString(font, weight, italic, px) {
  return `${italic ? "italic " : ""}${weight} ${px.toFixed(2)}px "${font}", ${FALLBACK}`;
}

export function fontEpoch() {
  return epoch;
}

export function onFontsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function glyphsOf(pages) {
  const text = (pages || []).flatMap((p) => p.words.map((w) => w.text)).join("");
  return [...new Set(text + text.toLocaleUpperCase() + text.toLocaleLowerCase())].join("") || "AaBbCc123";
}

export async function ensureFont(font, weight = 700, italic = false, sample = "Aa") {
  if (typeof document === "undefined") return;
  await loadFontManifest();
  const family = families[font];
  if (family && !registered.has(font)) {
    registered.add(font);
    for (const face of family.faces) {
      try {
        const ff = new FontFace(font, `url(./fonts/${face.file}) format("woff2")`, {
          weight: String(face.weight),
          style: face.style,
          unicodeRange: face.range,
        });
        document.fonts.add(ff);
      } catch {
        // Ignore individual subset registration errors
      }
    }
  }
  try {
    await document.fonts.load(fontString(font, weight, italic, 36), sample || "Aa");
  } catch {
    // Graceful fallback to system font
  }
  epoch++;
  listeners.forEach((fn) => fn());
}

# CapStream — Free Offline-Ready AI Video & Audio Captions PWA

**Powered by [Unskyit](https://unskyit.com)**

> **Under 2 MB GitHub Repo • Offline-First Native PWA • Disk-Streamed Unlimited Video Length • Transparent Background Alpha Export • Zero Uploads • Zero Watermarks**

CapStream is a zero-build, installable Progressive Web App (PWA) for generating animated, word-level AI captions completely on your own device. Drop in any **video or audio file**, transcribe locally in **50+ languages** using official OpenAI Whisper ONNX models cached directly on your device, customize with **28 viral & classic styles**, and export straight to disk—including **transparent background overlays** for Premiere Pro, DaVinci Resolve, CapCut, After Effects, and Blender.

---

## Why CapStream?

| Feature | CapStream (Unskyit) | Typical Browser Caption Tools |
| :--- | :--- | :--- |
| **Repo Footprint** | **~1.7 MB** (way under GitHub's 100 MB limit) | Heavy builds or oversized assets |
| **Offline PWA Feel** | **Installable Native PWA (`sw.js`)** — caches app, libraries & Whisper models on-device | Breaks without internet |
| **Model Download Transparency** | **Live MB, %, MB/s speed & 1-click Pre-Download / Clear Cache** | Hidden downloads |
| **Video Length Limit** | **Unlimited** (Disk-Streamed via File System Access API) | Capped at 5–10 minutes |
| **Audio-Only Support** | **Full Support** (MP3, WAV, M4A, FLAC, OGG, AAC, OPUS) | Video-only |
| **Transparent BG Export** | **WebM VP9 Alpha, Lossless PNG Sequence & Chroma Key MP4** | Opaque H.264 MP4 only |
| **Caption Styles** | **28 Styles** (10 Viral Creator + 18 Classic) + Full Customizer | Basic templates |
| **Hosting** | **Zero-Build** — Drag & drop straight onto GitHub Pages | Requires Node.js / Next.js |

---

## Offline Caching & Whisper Model Sizes

CapStream keeps the GitHub repository tiny (~1.7 MB) while giving users a **100% offline-capable native app experience**:

1. **App Shell & 18 Local Fonts (~1.7 MB):** Bundled directly inside this repo and precached by `sw.js`.
2. **Pinned Browser Runtimes:** `@huggingface/transformers@4.3.2` and `mediabunny@1.66.0` load once from jsDelivr CDN and are automatically cached by `sw.js` for offline reuse.
3. **Long-Term Official Whisper ONNX Models (`onnx-community` on Hugging Face):**
   - **Fast (Whisper Tiny)** — `~67 MB` (fastest download, ideal for mobile)
   - **Balanced (Whisper Base)** — `~103 MB` (recommended for most creators)
   - **Accurate (Whisper Small)** — `~275 MB` (best for accents & noisy audio)

Users see the exact **MB downloaded, total MB, live %, and MB/s speed**, can pre-download their preferred model for offline flights/travel with one click, and can clear cached models anytime.

---

## Key Features

- **Direct Upload Landing:** Opens straight to the **Select Video or Audio** dropzone in a calm, crisp White, Blue & Premium Navy interface—responsive on both desktop and mobile.
- **Disk-Streamed Export (`StreamTarget`):** On Chrome and Edge desktop, streams encoded frames directly to your hard drive so long videos and 4K exports keep RAM flat.
- **Transparent Background Overlays:**
  - **WebM (VP9 Alpha + Opus)** — True alpha channel for **Premiere Pro, DaVinci Resolve, CapCut Desktop, After Effects, OBS**.
  - **Lossless Transparent PNG Sequence (Direct to Folder)** — Streams RGBA `.png` frames straight to a folder for **Blender, After Effects, DaVinci Resolve, Premiere Pro**.
  - **Chroma Key Green (`#00FF00`) / Blue (`#0000FF`) MP4** — 100% compatible with **CapCut Mobile, VN, Alight Motion**, and any NLE.
  - **H.265 / HEVC & H.264 MP4** + **`.SRT`, `.VTT`, `.ASS`, `.TXT`** export and `.SRT`/`.VTT` import.
- **28 Built-In Styles:** 10 viral creator presets (*Hormozi Pop, Beast Slam, Cyber Blue, Iman Luxury, Kinetic Wave, Fire Viral, Podcast Pro, Creator Pill, Docu Cinema, Cyber Glitch*) + 18 classic presets.
- **Batch Queue & Custom Vocabulary:** Queue multiple video/audio files, apply brand spelling replacements (`unsky it = Unskyit`), and export sequentially.

---

## Deploy to GitHub Pages in 60 Seconds (Zero Build)

1. Create a new GitHub repository (e.g., `unskyit/capstream`).
2. Drag and drop all files and folders from `capstream-unskyit/` into the repository root (keep `.nojekyll`, `sw.js`, `manifest.json`, and `fonts/` intact).
3. Enable **Settings → Pages → Deploy from a branch (`main` / `root`)**.
4. Open `https://<your-username>.github.io/capstream/` and click **Install App** in the top bar to use it like a native desktop or mobile app!

---

## License & Credits

CapStream is licensed under **AGPL-3.0-only** (see [LICENSE](LICENSE)).  
Powered by **[Unskyit](https://unskyit.com)**. Built on [Whisper](https://github.com/openai/whisper) (MIT), [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0), [Mediabunny](https://mediabunny.dev) (MPL-2.0), inspired by [loudcaps-open](https://github.com/AbayAtazhan/loudcaps-open), and bundled open-source fonts (see `fonts/LICENSES.md`).

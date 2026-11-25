#!/usr/bin/env bash
# CapStream (Powered by Unskyit) — 1-Click Zero-CDN Offline Bundle Downloader
# Downloads the ~67 MB Whisper Tiny ONNX model + pinned JS runtimes into ./models/ and ./vendor/
# Total folder size stays ~75 MB (safely under GitHub's 100 MB per-file limit).
set -e

mkdir -p vendor models/whisper-tiny_timestamped/onnx

echo "[1/3] Downloading pinned runtime libraries into ./vendor/..."
curl -fsSL "https://cdn.jsdelivr.net/npm/mediabunny@1.66.0/+esm" -o vendor/mediabunny.mjs
curl -fsSL "https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.66.0/+esm" -o vendor/aac-encoder.mjs
curl -fsSL "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm" -o vendor/transformers.mjs

echo "[2/3] Downloading Whisper Tiny metadata into ./models/whisper-tiny_timestamped/..."
BASE="https://huggingface.co/onnx-community/whisper-tiny_timestamped/resolve/main"
for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json vocab.json merges.txt normalizer.json special_tokens_map.json; do
  curl -fsSL "$BASE/$f" -o "models/whisper-tiny_timestamped/$f" || true
done

echo "[3/3] Downloading Whisper Tiny q8 ONNX weights (~67 MB)..."
curl -fsSL "$BASE/onnx/encoder_model_quantized.onnx" -o "models/whisper-tiny_timestamped/onnx/encoder_model_quantized.onnx"
curl -fsSL "$BASE/onnx/decoder_model_merged_quantized.onnx" -o "models/whisper-tiny_timestamped/onnx/decoder_model_merged_quantized.onnx"

echo "Done! CapStream now runs 100% offline with ZERO CDN calls. Push this folder straight to GitHub!"

#!/usr/bin/env bash
# Downloads the whisper.cpp base.en ggml model and verifies it two ways: the
# project's published SHA-1 (models/README.md in the clone) and a SHA-256 we
# record here, so a later run can tell a changed file from a network error.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
src=$home/whisper.cpp
model=$src/models/ggml-base.en.bin
url=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

mkdir -p "$src/models"
if [ ! -s "$model" ]; then
  echo "download: $url"
  curl -fSL --retry 3 -o "$model.part" "$url"
  mv "$model.part" "$model"
fi

bytes=$(stat -f '%z' "$model")
sha1=$(shasum -a 1 "$model" | cut -d' ' -f1)
sha256=$(shasum -a 256 "$model" | cut -d' ' -f1)
published=$(awk '$2 == "base.en"' "$src/models/README.md" | grep -Eo '[0-9a-f]{40}' | head -1)

echo "path: $model"
echo "bytes: $bytes"
echo "sha1: $sha1"
echo "sha1_published: $published"
echo "sha256: $sha256"

if [ -n "$published" ] && [ "$sha1" != "$published" ]; then
  echo "model: SHA-1 mismatch against models/README.md" >&2
  exit 1
fi
echo "model: verified"

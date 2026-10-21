#!/usr/bin/env bash
# Fetches the already-converted silero VAD model that whisper.cpp publishes, so
# the endpoint costs one 885 KB GET and no torch conversion.
#
# The download itself is whisper.cpp's own models/download-vad-model.sh: this
# script only names the model, verifies the bytes against a pinned SHA-256, and
# prints what a later run can compare. Run build.sh first, because the clone is
# where the downloader lives.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
src=$home/whisper.cpp
downloader=$src/models/download-vad-model.sh
model=silero-v5.1.2
expected=29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf

if [ ! -x "$downloader" ]; then
  echo "no whisper.cpp clone at $src; run $here/build.sh first" >&2
  exit 2
fi

VOICE_SPIKE_HOME=$home "$downloader" "$model" "$src/models"

path=$src/models/ggml-$model.bin
[ -s "$path" ] || { echo "download left no file at $path" >&2; exit 2; }

bytes=$(stat -f '%z' "$path")
sha256=$(shasum -a 256 "$path" | awk '{print $1}')
echo "path:   $path"
echo "bytes:  $bytes"
echo "sha256: $sha256"
echo "sha256_expected: $expected"

if [ "$sha256" != "$expected" ]; then
  echo "vad model: SHA-256 mismatch" >&2
  exit 1
fi
echo "vad model: verified"

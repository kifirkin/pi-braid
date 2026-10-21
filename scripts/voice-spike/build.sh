#!/usr/bin/env bash
# Builds whisper.cpp from source. Native only: no torch, no onnxruntime, no GPU.
#
#   VOICE_SPIKE_HOME=/some/dir scripts/voice-spike/build.sh
#
# Prints the compiler, the configure and build wall times, and the resulting
# binaries. Re-running is cheap: the clone and build are reused.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
src=$home/whisper.cpp
repo=https://github.com/ggml-org/whisper.cpp.git

mkdir -p "$home"
if [ ! -d "$src/.git" ]; then
  echo "clone: $repo"
  git clone --depth 1 "$repo" "$src"
fi
echo "commit: $(git -C "$src" rev-parse HEAD)"

echo "cc: $(/usr/bin/cc --version | head -1)"
echo "cmake: $(cmake --version | head -1)"

# Metal is off: this is an Intel Mac with no GPU compute, and the framework
# being present is not the same as it being usable.
if [ ! -f "$src/build/CMakeCache.txt" ]; then
  /usr/bin/time -p cmake -S "$src" -B "$src/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWHISPER_BUILD_TESTS=OFF \
    -DGGML_METAL=OFF 2>&1 | sed -n '/^-- Configuring/,$p'
else
  echo "configure: reused $src/build"
fi

/usr/bin/time -p cmake --build "$src/build" --config Release -j "$(sysctl -n hw.ncpu)" 2>&1 |
  sed -n '/Built target whisper-cli/,$p'

echo "binaries:"
ls -l "$src/build/bin/whisper-cli" "$src/build/bin/whisper-server" | awk '{print $5, $9}'
file "$src/build/bin/whisper-cli" | sed 's/.*: //'

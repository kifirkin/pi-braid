#!/usr/bin/env bash
# Records the default input device for N seconds and refuses to call digital
# silence a success. The capture is AudioQueue (aqrec.m), not
# `ffmpeg -f avfoundation`, because the latter blocks inside
# -[AVCaptureSession startRunning] in a launchd Background session.
#
#   capture.sh [SECONDS] [OUT.wav]
#
# Set the input gain first: a mute at input volume 0 also records silence and is
# indistinguishable from a permission denial until you check the level.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
out=${2:-$here/out/capture.wav}
secs=${1:-3}

mkdir -p "$(dirname "$out")" "$home/out"
bin=$home/aqrec
if [ ! -x "$bin" ] || [ "$here/aqrec.m" -nt "$bin" ]; then
  /usr/bin/clang -O2 -fobjc-arc -framework AudioToolbox -framework Foundation \
    "$here/aqrec.m" -o "$bin"
fi

raw=$home/out/capture.pcm
"$bin" "$secs" "$raw"

ffmpeg -hide_banner -nostdin -loglevel error -f s16le -ar 16000 -ac 1 -i "$raw" \
  -c:a pcm_s16le -y "$out"

python3 "$here/rms.py" "$out" | tee "$home/out/capture-level.json"

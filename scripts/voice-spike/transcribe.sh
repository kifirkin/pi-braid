#!/usr/bin/env bash
# Transcribes a WAV with whisper-cli, RUNS times, and reports wall time, the
# real-time factor and peak RSS per run. One process per utterance: the model
# load is inside every number, which is the honest per-turn cost.
#
#   transcribe.sh FILE.wav [RUNS]
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
cli=$home/whisper.cpp/build/bin/whisper-cli
model=$home/whisper.cpp/models/ggml-base.en.bin
wav=${1:?usage: transcribe.sh FILE.wav [RUNS]}
runs=${2:-3}

[ -s "$wav" ] || { echo "no such wav: $wav" >&2; exit 2; }
[ -x "$cli" ] || { echo "build first: $here/build.sh" >&2; exit 2; }

mkdir -p "$here/out"
audio_s=$(python3 -c "import sys; sys.path.insert(0, '$here'); import rms; print(rms.analyze('$wav')['duration_s'])")
echo "audio_s: $audio_s"

for i in $(seq 1 "$runs"); do
  json=$(python3 "$here/measured.py" -- "$cli" -m "$model" -f "$wav" -nt -np -l en)
  printf '%s' "$json" > "$here/out/whisper-$i.json"
  python3 - "$json" "$audio_s" "$i" <<'PY'
import json, sys
m = json.loads(sys.argv[1]); audio = float(sys.argv[2]); run = sys.argv[3]
text = m["stdout"].strip().replace("\n", " ")
print(json.dumps({
    "run": int(run),
    "wall_s": m["wall_s"],
    "peak_rss_kb": m["peak_rss_kb"],
    "rusage_max_child_kb": m["rusage_max_child_kb"],
    "audio_s": audio,
    "realtime_factor": round(audio / m["wall_s"], 2) if m["wall_s"] else None,
    "transcript": text,
}))
PY
done

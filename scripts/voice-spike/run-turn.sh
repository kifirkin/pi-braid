#!/usr/bin/env bash
# Three measured turns through the whole path, then the medians. Everything
# here is local: AudioQueue capture, whisper.cpp, `say`, `afplay`.
#
#   VOICE_SPIKE_HOME=/path/to/build run-turn.sh [RUNS]
#
# The stimulus is played through the speakers and recorded through the
# microphone, so the machine has to be the thing talking. A silent room, muted
# input or denied permission all show up as an RMS near -inf, and that fails
# the run rather than passing it.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
runs=${1:-3}
export VOICE_SPIKE_HOME=$home

mkdir -p "$here/out" "$home/out"
bin=$home/aqrec
if [ ! -x "$bin" ] || [ "$here/aqrec.m" -nt "$bin" ]; then
  /usr/bin/clang -O2 -fobjc-arc -framework AudioToolbox -framework Foundation \
    "$here/aqrec.m" -o "$bin"
fi

[ -x "$home/whisper.cpp/build/bin/whisper-cli" ] || { echo "build first: $here/build.sh" >&2; exit 2; }
[ -s "$home/whisper.cpp/models/ggml-base.en.bin" ] || { echo "model first: $here/fetch-model.sh" >&2; exit 2; }

input=$(osascript -e 'input volume of (get volume settings)' 2>/dev/null || echo unknown)
echo "input_volume: $input"
if [ "$input" = "0" ]; then
  echo "input volume is 0: every capture would be digital silence" >&2
  echo "run: osascript -e 'set volume input volume 80'" >&2
  exit 2
fi

failed=0
for i in $(seq 1 "$runs"); do
  # A silent capture, an empty transcript or an undetectable end marker is a
  # failed measurement, not a slow one. Count it, keep going so the spread is
  # visible, and exit non-zero if any turn failed.
  python3 "$here/turn.py" --index "$i" > "$home/out/turn-$i.log" 2>&1 || failed=$((failed + 1))
  python3 - "$here/out/turn-$i.json" "$i" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
s = r["stages_ms"]
print(json.dumps({
    "run": r["run"],
    "rms_dbfs": r["capture"]["rms_dbfs"],
    "speech_end_s": r["speech_end"]["end_s"],
    "player_exit_lag_s": r["speech_end"]["player_exit_lag_s"],
    "speech_end_to_transcript_ms": s["speech_end_to_transcript"],
    "transcript_to_first_token_ms": s["transcript_to_first_token"],
    "first_token_to_play_start_ms": s["first_token_to_play_start"],
    "play_start_to_first_audio_ms": s["play_start_to_first_audio"],
    "speech_end_to_first_audio_ms": s["speech_end_to_first_audio"],
    "stt_wall_s": r["stt"]["wall_s"],
    "rtf": r["stt"]["realtime_factor"],
    "peak_rss_kb": r["stt"]["peak_rss_kb"],
    "transcript": r["stt"]["transcript"],
}))
PY
done

python3 "$here/turn.py" --summary "$here/out/turn-*.json"
if [ "$failed" -ne 0 ]; then
  echo "failed_turns: $failed of $runs" >&2
  exit 1
fi

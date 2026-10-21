#!/usr/bin/env bash
# One v2 batch: the resident synthesizer and the adaptive endpoint, measured
# apart against the v1 control, on one stimulus, one device pair, one session.
#
#   VOICE_SPIKE_HOME=/private/tmp/voice-spike-build run-batch-v2.sh 10
#   VOICE_SPIKE_HELLO=25 run-batch-v2.sh 1 "say-window"     # smoke test
#
# The arms are `say-window` (v1 control), `resident-window` (the synthesiser
# alone), `say-adaptive` (the endpoint alone) and `resident-adaptive` (both).
# Everything the numbers are not comparable without is pinned, printed, and put
# back on every exit path: both gains, both devices, the stimulus file.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
turns=${1:-10}
# Window arms by default: the adaptive endpoint is measured and reported as an
# open problem, not offered as the working configuration.
arms=${2:-"say-window resident-window"}
export VOICE_SPIKE_HOME=$home
export VOICE_SPIKE_HANGOVER_MS=${VOICE_SPIKE_HANGOVER_MS:-500}
export VOICE_SPIKE_REPLY=${VOICE_SPIKE_REPLY:-"The transcript is ready. The model stayed resident between turns. Nothing left this machine."}
gain=${VOICE_SPIKE_INPUT_GAIN:-80}

server=$home/whisper.cpp/build/bin/whisper-server
model=$home/whisper.cpp/models/ggml-base.en.bin
[ -x "$server" ] || { echo "build first: $here/build.sh" >&2; exit 2; }
[ -s "$model" ] || { echo "model first: $here/fetch-model.sh" >&2; exit 2; }
mkdir -p "$home/out" "$here/out"

# Build what this batch needs, using the compiler that works here. The LLVM in
# /usr/local is broken on this box (missing libz3), so the SDK clang is named.
cc=/usr/bin/clang
# Rebuilt when missing or stale, and the version that ran is printed: a batch
# that silently used the previous binary measured the previous code.
build() {  # build SRC OUT FRAMEWORKS...
  src=$1; out=$2; shift 2
  if [ ! -x "$out" ] || [ "$src" -nt "$out" ]; then
    $cc -O2 -fobjc-arc -Wno-deprecated-declarations "$@" "$src" -o "$out"
    echo "built: $out"
  else
    echo "reused: $out"
  fi
  echo "built_at: $out $(date -r "$out" '+%Y-%m-%dT%H:%M:%S')"
}
build "$here/aqrec.m" "$home/aqrec" -framework AudioToolbox -framework Foundation
build "$here/avspeak.m" "$home/avspeak" -framework AVFoundation \
      -framework AudioToolbox -framework Foundation
build "$here/audio-device.m" "$home/audio-device" -framework CoreAudio -framework Foundation
dev=$home/audio-device

# One experiment per directory: a summary cannot mix two sessions.
rm -f "$here"/out/v2-*.json "$here"/out/probe-*.json

found_in_uid=$("$dev" get in | awk -F= '/^uid=/{print $2}')
found_out_uid=$("$dev" get out | awk -F= '/^uid=/{print $2}')
print_dev() { "$dev" get "$1" | paste -sd' ' -; }
echo "device_in_found:   $(print_dev in)"
echo "device_out_found:  $(print_dev out)"
[ -n "${VOICE_SPIKE_DEVICE_IN:-}" ] && "$dev" set in "$VOICE_SPIKE_DEVICE_IN" > /dev/null
[ -n "${VOICE_SPIKE_DEVICE_OUT:-}" ] && "$dev" set out "$VOICE_SPIKE_DEVICE_OUT" > /dev/null
echo "device_in_run:     $(print_dev in)"
echo "device_out_run:    $(print_dev out)"

found=$(osascript -e 'input volume of (get volume settings)')
case $found in ''|*[!0-9]*) echo "cannot read input volume: '$found'" >&2; exit 2;; esac
found_out=$(osascript -e 'output volume of (get volume settings)')
case $found_out in ''|*[!0-9]*) echo "cannot read output volume: '$found_out'" >&2; exit 2;; esac
echo "input_volume_found:  $found"
echo "input_volume_run:    $gain"
echo "output_volume_found: $found_out"
echo "output_volume_run:   ${VOICE_SPIKE_OUTPUT_GAIN:-unchanged}"

server_pid=
restore() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=
  fi
  osascript -e "set volume input volume $found" >/dev/null
  osascript -e "set volume output volume $found_out" >/dev/null
  echo "input_volume_restored_to: $found"
  echo "input_volume_now:         $(osascript -e 'input volume of (get volume settings)')"
  echo "output_volume_restored_to: $found_out"
  echo "output_volume_now:         $(osascript -e 'output volume of (get volume settings)')"
  [ -n "$found_in_uid" ] && "$dev" set in "$found_in_uid" > /dev/null 2>&1 || true
  [ -n "$found_out_uid" ] && "$dev" set out "$found_out_uid" > /dev/null 2>&1 || true
  echo "device_in_now:     $(print_dev in)"
  echo "device_out_now:    $(print_dev out)"
}
trap restore EXIT INT TERM

osascript -e "set volume input volume $gain" >/dev/null
[ -n "${VOICE_SPIKE_OUTPUT_GAIN:-}" ] && osascript -e "set volume output volume $VOICE_SPIKE_OUTPUT_GAIN" >/dev/null
now_gain=$(osascript -e 'input volume of (get volume settings)')
[ "$now_gain" = "$gain" ] || { echo "input volume is $now_gain, wanted $gain" >&2; exit 2; }

# The stimulus is synthesised once, before any clock starts, and every arm
# reads this one file.
python3 - "$here" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import turn
turn.build_stimulus(turn.STIMULUS, "%s/out/stimulus.wav" % sys.argv[1])
PY
stimulus=$here/out/stimulus.wav
stim_before=$(shasum -a 256 "$stimulus" | awk '{print $1}')
echo "stimulus_sha256_before: $stim_before"
echo "stimulus: $(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import turn; print(repr(turn.STIMULUS))' "$here")"

port=$(python3 -c 'import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
export VOICE_SPIKE_SERVER_PORT=$port
echo "server_port: $port"

"$server" -m "$model" --host 127.0.0.1 --port "$port" -nt > "$home/out/server-v2.log" 2>&1 &
server_pid=$!
python3 - "$port" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
for _ in range(600):
    with socket.socket() as s:
        s.settimeout(0.2)
        if s.connect_ex(("127.0.0.1", port)) == 0:
            sys.exit(0)
    time.sleep(0.1)
sys.exit("server did not open a port")
PY

# A resident model pages in on its first request. Pay it here, once, outside
# every turn's clock, and report it as the session's model load.
python3 - "$here" "$port" "$stimulus" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
import importlib.util
spec = importlib.util.spec_from_file_location("turn_v1", sys.argv[1] + "/turn-v1.py")
v1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(v1)
warm = v1.server_post(sys.argv[3], int(sys.argv[2]))
print(json.dumps({"warmup_request_ms": warm["request_ms"], "warmup_text": warm["text"]}))
PY

echo "=== arms: $arms, $turns turns each ==="
arms_arg=${arms// /,}
python3 "$here/turn-v2.py" batch --turns "$turns" --arms "$arms_arg" --port "$port" \
  | tee "$home/out/batch-v2.log"

# The acoustic ground truth for the synthesis leg: the microphone, not the
# AudioQueue, decides when the first sound reached the room.
python3 "$here/turn-v2.py" probe --turns "${VOICE_SPIKE_PROBES:-5}" \
  > "$home/out/probe-v2.json"
cat "$home/out/probe-v2.json"

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=

stim_after=$(shasum -a 256 "$stimulus" | awk '{print $1}')
echo "stimulus_sha256_after:  $stim_after"
[ "$stim_before" = "$stim_after" ] || { echo "stimulus changed during the batch" >&2; exit 1; }

specs=()
for arm in $arms; do specs+=("$arm:$here/out/v2-$arm-*.json"); done
primary=${VOICE_SPIKE_PRIMARY:-resident-window}
python3 "$here/turn-v2.py" report "${specs[@]}" --primary "$primary" \
  > "$home/out/report-v2.json"
python3 - "$home/out/report-v2.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
for label, s in r["summary"].items():
    print(json.dumps({"arm": label, **{k: s[k] for k in (
        "turns", "turns_ok", "turns_failed", "p50_ms", "p90_ms",
        "p50_corrected_ms", "p90_corrected_ms", "end_reasons", "clipped_turns",
        "stt_median_ms", "first_synth_median_ms", "exact_transcripts")}}))
print(json.dumps({"decision": r.get("decision")}))
PY

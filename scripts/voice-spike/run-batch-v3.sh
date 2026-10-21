#!/usr/bin/env bash
# One v3 batch: the silero speech-end decision against the v2 control, on one
# stimulus, one device pair, one session, one resident model.
#
#   VOICE_SPIKE_HOME=/private/tmp/voice-spike-build run-batch-v3.sh 10
#
# The arms are `resident-window` (the v2 control: same resident synthesiser,
# same capture, fixed window) and `resident-vad` (silero decides, the window is
# only the cap). Both run in one process against the stimulus file built before
# either clock starts, so p50 and p90 are paired rather than merely comparable.
#
# Everything the numbers are not comparable without is pinned, printed, and put
# back on every exit path: both gains, both devices, the stimulus file.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
turns=${1:-10}
arms=${2:-"resident-window resident-vad"}
export VOICE_SPIKE_HOME=$home
export VOICE_SPIKE_VAD_HANGOVER_MS=${VOICE_SPIKE_VAD_HANGOVER_MS:-300}
export VOICE_SPIKE_REPLY=${VOICE_SPIKE_REPLY:-"The transcript is ready. The model stayed resident between turns. Nothing left this machine."}
gain=${VOICE_SPIKE_INPUT_GAIN:-80}
out_gain=${VOICE_SPIKE_OUTPUT_GAIN:-35}

src=$home/whisper.cpp
server=$src/build/bin/whisper-server
model=$src/models/ggml-base.en.bin
vad_model=$src/models/ggml-silero-v5.1.2.bin
[ -x "$server" ] || { echo "build first: $here/build.sh" >&2; exit 2; }
[ -s "$model" ] || { echo "model first: $here/fetch-model.sh" >&2; exit 2; }
[ -s "$vad_model" ] || VOICE_SPIKE_HOME=$home "$here/fetch-vad-model.sh"
echo "vad_model_sha256: $(shasum -a 256 "$vad_model" | awk '{print $1}')"
echo "vad_model_bytes:  $(stat -f '%z' "$vad_model")"

mkdir -p "$home/out" "$here/out"

# The compiler is named because the LLVM in /usr/local is broken on this box
# (missing libz3). The exit code is printed for every build; a batch that
# silently kept the previous binary measured the previous code.
cc=/usr/bin/clang
build() {  # build SRC OUT ARGS...
  local src_file=$1 out=$2
  shift 2
  local cmd=("$cc" -O2 -fobjc-arc -Wno-deprecated-declarations "$src_file" -o "$out" "$@")
  echo "clang: ${cmd[*]}"
  if "${cmd[@]}"; then echo "clang_exit=0"; else
    local rc=$?
    echo "clang_exit=$rc"
    return "$rc"
  fi
  echo "built_at: $out $(date -r "$out" '+%Y-%m-%dT%H:%M:%S')"
}
# libwhisper is linked dynamically, with an rpath into the build tree: the
# whisper.cpp build ships no static archives, and the recorder carries no copy
# of the library. The library loads the VAD model the script fetched.
build "$here/aqrec.m" "$home/aqrec" \
  -I "$src/include" -I "$src/ggml/include" \
  -L "$src/build/bin" -lwhisper -Wl,-rpath,"$src/build/bin" \
  -framework AudioToolbox -framework Foundation
build "$here/avspeak.m" "$home/avspeak" \
  -framework AVFoundation -framework AudioToolbox -framework Foundation
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
echo "output_volume_run:   $out_gain"

server_pid=
restore() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=
  fi
  osascript -e "set volume input volume $found" >/dev/null
  osascript -e "set volume output volume $found_out" >/dev/null
  echo "input_volume_restored_to:  $found"
  echo "input_volume_now:          $(osascript -e 'input volume of (get volume settings)')"
  echo "output_volume_restored_to: $found_out"
  echo "output_volume_now:         $(osascript -e 'output volume of (get volume settings)')"
  [ -n "$found_in_uid" ] && "$dev" set in "$found_in_uid" > /dev/null 2>&1 || true
  [ -n "$found_out_uid" ] && "$dev" set out "$found_out_uid" > /dev/null 2>&1 || true
  echo "device_in_now:     $(print_dev in)"
  echo "device_out_now:    $(print_dev out)"
}
trap restore EXIT INT TERM

osascript -e "set volume input volume $gain" >/dev/null
osascript -e "set volume output volume $out_gain" >/dev/null
now_gain=$(osascript -e 'input volume of (get volume settings)')
[ "$now_gain" = "$gain" ] || { echo "input volume is $now_gain, wanted $gain" >&2; exit 2; }
now_out=$(osascript -e 'output volume of (get volume settings)')
[ "$now_out" = "$out_gain" ] || { echo "output volume is $now_out, wanted $out_gain" >&2; exit 2; }

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
echo "stimulus_duration_s: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$stimulus")"

port=$(python3 -c 'import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
export VOICE_SPIKE_SERVER_PORT=$port
echo "server_port: $port"

"$server" -m "$model" --host 127.0.0.1 --port "$port" -nt > "$home/out/server-v3.log" 2>&1 &
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
import importlib.util, json, sys
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("turn_v1", sys.argv[1] + "/turn-v1.py")
v1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(v1)
warm = v1.server_post(sys.argv[3], int(sys.argv[2]))
print(json.dumps({"warmup_request_ms": warm["request_ms"], "warmup_text": warm["text"]}))
PY

# The first AudioQueue start after an idle period is slower than the rest; a
# throwaway capture pays that once, so turn 1 is not the only turn whose clock
# is anchored differently. Its bytes are printed as proof it ran.
"$home/aqrec" 0.5 "$home/out/capture-warmup.pcm" \
  > /dev/null 2> "$home/out/capture-warmup.log"
echo "capture_warmup_bytes: $(stat -f '%z' "$home/out/capture-warmup.pcm")"

echo "=== arms: $arms, $turns turns each ==="
arms_arg=${arms// /,}
python3 "$here/turn-v2.py" batch --turns "$turns" --arms "$arms_arg" --port "$port" \
  | tee "$home/out/batch-v3.log"

# The acoustic ground truth for the synthesis leg: the microphone, not the
# AudioQueue, decides when the first sound reached the room.
python3 "$here/turn-v2.py" probe --turns "${VOICE_SPIKE_PROBES:-5}" \
  > "$home/out/probe-v3.json"
cat "$home/out/probe-v3.json"

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=

stim_after=$(shasum -a 256 "$stimulus" | awk '{print $1}')
echo "stimulus_sha256_after:  $stim_after"
[ "$stim_before" = "$stim_after" ] || { echo "stimulus changed during the batch" >&2; exit 1; }

specs=()
for arm in $arms; do specs+=("$arm:$here/out/v2-$arm-*.json"); done
python3 "$here/turn-v3.py" report "${specs[@]}" --primary "${VOICE_SPIKE_PRIMARY:-resident-vad}" \
  > "$home/out/report-v3.json"
python3 "$here/turn-v3.py" report "${specs[@]}" --primary "${VOICE_SPIKE_PRIMARY:-resident-vad}" \
  --markdown | tee "$home/out/report-v3.md"

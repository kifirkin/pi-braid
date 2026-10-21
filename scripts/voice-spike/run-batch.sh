#!/usr/bin/env bash
# Measured batches of voice turns, with the input-gain discipline the first
# spike learned from a muted capture.
#
#   run-batch.sh [TURNS] [CONFIGS]
#
# TURNS defaults to 10. CONFIGS is a space-separated subset of "v0 v1 v1b"
# (default: all three, control first). One `whisper-server` is started for the
# whole batch and warmed up before the first turn, so the model load is paid
# once per session; the v0 control runs `turn.py` untouched, one `whisper-cli`
# process per utterance, and both read the same stimulus file.
#
# The input volume is read, raised for the run, and restored on every exit
# path. Both values are printed. A capture whose RMS is below the noise floor
# fails its turn regardless of exit status.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
home=${VOICE_SPIKE_HOME:-$here/.work}
turns=${1:-10}
configs=${2:-"v0 v1 v1b"}
gain=${VOICE_SPIKE_INPUT_GAIN:-80}
export VOICE_SPIKE_HOME=$home
# One reply text for both configurations, so the answer leg differs only in
# whether the whole reply is synthesised before the first sound starts.
export VOICE_SPIKE_REPLY=${VOICE_SPIKE_REPLY:-"The transcript is ready. The model stayed resident between turns. Nothing left this machine."}
export VOICE_SPIKE_END_MS=${VOICE_SPIKE_END_MS:-300}

server=$home/whisper.cpp/build/bin/whisper-server
model=$home/whisper.cpp/models/ggml-base.en.bin
[ -x "$server" ] || { echo "build first: $here/build.sh" >&2; exit 2; }
[ -s "$model" ] || { echo "model first: $here/fetch-model.sh" >&2; exit 2; }

mkdir -p "$here/out" "$home/out"
if [ ! -x "$home/aqrec" ] || [ "$here/aqrec.m" -nt "$home/aqrec" ]; then
  /usr/bin/clang -O2 -fobjc-arc -framework AudioToolbox -framework Foundation \
    "$here/aqrec.m" -o "$home/aqrec"
fi
dev=$home/audio-device
if [ ! -x "$dev" ] || [ "$here/audio-device.m" -nt "$dev" ]; then
  /usr/bin/clang -O2 -fobjc-arc -framework CoreAudio -framework Foundation \
    "$here/audio-device.m" -o "$dev"
fi

# Every batch is one experiment: clear the previous batch's per-turn records so
# a summary cannot mix two sessions.
rm -f "$here"/out/turn-*.json "$here"/out/v1-*.json

# Device pair and gain are two halves of the same problem the first spike hit:
# a capture can be wrong without any process failing. macOS switches both
# defaults when a Bluetooth speaker connects, so record what is found, pin the
# pair when asked, and put it back on every exit path.
found_in_uid=$("$dev" get in | awk -F= '/^uid=/{print $2}')
found_out_uid=$("$dev" get out | awk -F= '/^uid=/{print $2}')
print_dev() { "$dev" get "$1" | paste -sd' ' -; }
echo "device_in_found:   $(print_dev in)"
echo "device_out_found:  $(print_dev out)"
if [ -n "${VOICE_SPIKE_DEVICE_IN:-}" ]; then
  "$dev" set in "$VOICE_SPIKE_DEVICE_IN" > /dev/null
fi
if [ -n "${VOICE_SPIKE_DEVICE_OUT:-}" ]; then
  "$dev" set out "$VOICE_SPIKE_DEVICE_OUT" > /dev/null
fi
echo "device_in_run:     $(print_dev in)"
echo "device_out_run:    $(print_dev out)"

found=$(osascript -e 'input volume of (get volume settings)')
case $found in ''|*[!0-9]*) echo "cannot read input volume: '$found'" >&2; exit 2;; esac
found_out=$(osascript -e 'output volume of (get volume settings)')
case $found_out in ''|*[!0-9]*) echo "cannot read output volume: '$found_out'" >&2; exit 2;; esac
echo "input_volume_found:  $found"
echo "input_volume_run:    $gain"
echo "output_volume_found: $found_out"
[ -n "${VOICE_SPIKE_OUTPUT_GAIN:-}" ] && echo "output_volume_run:   $VOICE_SPIKE_OUTPUT_GAIN"

server_pid=
restore() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=
  fi
  osascript -e "set volume input volume $found" >/dev/null
  [ -n "$found_out" ] && osascript -e "set volume output volume $found_out" >/dev/null
  local now
  now=$(osascript -e 'input volume of (get volume settings)')
  echo "input_volume_restored_to: $found"
  echo "input_volume_now:         $now"
  echo "output_volume_now:        $(osascript -e 'output volume of (get volume settings)')"
  [ "$now" = "$found" ] || echo "WARNING: input volume not restored" >&2
  # Restore by UID: a name can be shared, and the Bluetooth device that was
  # default at the start is the one to put back, not whichever is default now.
  [ -n "$found_in_uid" ] && "$dev" set in "$found_in_uid" > /dev/null 2>&1 || true
  [ -n "$found_out_uid" ] && "$dev" set out "$found_out_uid" > /dev/null 2>&1 || true
  echo "device_in_now:     $(print_dev in)"
  echo "device_out_now:    $(print_dev out)"
}
trap restore EXIT INT TERM

osascript -e "set volume input volume $gain" >/dev/null
if [ -n "${VOICE_SPIKE_OUTPUT_GAIN:-}" ]; then
  osascript -e "set volume output volume $VOICE_SPIKE_OUTPUT_GAIN" >/dev/null
fi
now_gain=$(osascript -e 'input volume of (get volume settings)')
[ "$now_gain" = "$gain" ] || { echo "input volume is $now_gain, wanted $gain" >&2; exit 2; }

# The stimulus is synthesised once, before any clock starts, and both
# configurations read this one file.
python3 - "$here" <<'PY'
import sys
here = sys.argv[1]
sys.path.insert(0, here)
import turn
turn.build_stimulus(turn.STIMULUS, "%s/out/stimulus.wav" % here)
PY

stimulus=$here/out/stimulus.wav
stim_before=$(shasum -a 256 "$stimulus" | awk '{print $1}')
echo "stimulus_sha256_before: $stim_before"

port=$(python3 -c 'import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
export VOICE_SPIKE_SERVER_PORT=$port

"$server" -m "$model" --host 127.0.0.1 --port "$port" -nt > "$home/out/server.log" 2>&1 &
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

# A resident model still pages in on its first request. Pay it here, once, and
# report it: it is the session's model-load cost, not any turn's.
python3 - "$here" "$port" "$stimulus" <<'PY'
import json, sys
here, port, stimulus = sys.argv[1:4]
sys.path.insert(0, here)
import importlib.util
spec = importlib.util.spec_from_file_location("turn_v1", here + "/turn-v1.py")
v1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v1)
warm = v1.server_post(stimulus, int(port))
print(json.dumps({"warmup_request_ms": warm["request_ms"], "warmup_text": warm["text"]}))
PY

failed=0
for config in $configs; do
  echo "=== $config: $turns turns ==="
  for i in $(seq 1 "$turns"); do
    if [ "$config" = "v0" ]; then
      python3 "$here/turn.py" --index "$i" > "$home/out/$config-$i.log" 2>&1 || failed=$((failed + 1))
    else
      python3 "$here/turn-v1.py" --index "$i" --config "$config" --port "$port" \
        > "$home/out/$config-$i.log" 2>&1 || failed=$((failed + 1))
    fi
    python3 - "$here" "$config" "$i" <<'PY'
import json, sys
here, config, index = sys.argv[1:4]
path = (f"{here}/out/turn-{index}.json" if config == "v0"
        else f"{here}/out/v1-{config}-{index}.json")
try:
    r = json.load(open(path))
except Exception as exc:
    print(json.dumps({"config": config, "run": int(index), "error": str(exc)}))
    raise SystemExit(0)
s = r["stages_ms"]
v = r.get("validity") or {}
print(json.dumps({
    "config": config,
    "run": r["run"],
    "ok": v.get("ok"),
    "reasons": v.get("reasons"),
    "device": ((r.get("device") or {}).get("input") or {}).get("name"),
    "rms_dbfs": r["capture"]["rms_dbfs"],
    "speech_end_s": r["speech_end"]["end_s"],
    "speech_end_to_first_audio_ms": s["speech_end_to_first_audio"],
    "speech_end_to_first_audio_corrected_ms": s.get("speech_end_to_first_audio_corrected"),
    "transcript": r["stt"]["transcript"],
}))
PY
  done
done

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=

stim_after=$(shasum -a 256 "$stimulus" | awk '{print $1}')
echo "stimulus_sha256_after:  $stim_after"
[ "$stim_before" = "$stim_after" ] || { echo "stimulus changed during the batch" >&2; exit 1; }

python3 "$here/turn-v1.py" report \
  v0:"$here/out/turn-*.json" v1:"$here/out/v1-v1-*.json" v1b:"$here/out/v1-v1b-*.json"
if [ "$failed" -ne 0 ]; then
  echo "failed_turns: $failed" >&2
  exit 1
fi

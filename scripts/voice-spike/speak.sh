#!/usr/bin/env bash
# Speaks TEXT through the shipped TTS path: `say` to an AIFF, `afplay` to the
# speakers. Reports synthesis wall time and the time from play start until the
# player child was first observed alive. That second number proves the player
# started; it does not prove a sample reached the device, which ps cannot see.
#
#   speak.sh "TEXT" [OUT.aiff]
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
voice=${VOICE_SPIKE_VOICE:-Samantha}
rate=${VOICE_SPIKE_RATE:-175}
text=${1:?usage: speak.sh TEXT [OUT.aiff]}
aiff=${2:-$here/out/reply.aiff}

mkdir -p "$(dirname "$aiff")"
say -v "$voice" -r "$rate" -o "$aiff" "$text"
python3 - "$here" "$voice" "$rate" "$aiff" "$text" <<'PY'
import json, subprocess, sys, time
here, voice, rate, aiff, text = sys.argv[1:6]
sys.path.insert(0, here)
import measured

synth = measured.measure(["say", "-v", voice, "-r", rate, "-o", aiff, text])
t_play = time.monotonic()
player = subprocess.Popen(["afplay", aiff])
first_seen = None
while first_seen is None and player.poll() is None:
    if subprocess.run(["ps", "-o", "pid=", "-p", str(player.pid)],
                      capture_output=True, text=True).stdout.strip():
        first_seen = time.monotonic()
player.wait()
print(json.dumps({
    "synthesis_s": synth["wall_s"],
    "play_start_to_child_alive_s": round(first_seen - t_play, 4) if first_seen else None,
    "play_wall_s": round(time.monotonic() - t_play, 4),
    "aiff": aiff,
    "voice": voice,
    "text": text,
}))
PY

# Voice path spike

Proves the local speech path on this machine and measures what it costs.
Everything here is native: `whisper.cpp` built from source, AudioQueue capture,
`say` and `afplay`. Nothing imports torch or onnxruntime, because on Intel macOS
neither is installable.

## What each script does

| script | job |
|---|---|
| `build.sh` | clones whisper.cpp, configures with cmake (Metal off), builds `whisper-cli`/`whisper-server`, prints wall times |
| `fetch-model.sh` | downloads `ggml-base.en.bin`, verifies SHA-1 against the project's table, records SHA-256 |
| `capture.sh` | records the default input to 16 kHz mono WAV and prints its RMS |
| `transcribe.sh` | runs `whisper-cli` N times, reports wall, real-time factor, peak RSS, text |
| `speak.sh` | `say` to AIFF, `afplay` it, reports synthesis and play-start numbers |
| `run-turn.sh` | three full turns, the four timestamps each, then medians |
| `rms.py` | WAV level; digital silence is a failure, not a success |
| `measured.py` | wall time and peak RSS for one child process |
| `aqrec.m` | the capture layer (see below) |

Build and artifacts stay outside git under `VOICE_SPIKE_HOME` (default
`.work/`, ignored):

```
VOICE_SPIKE_HOME=/tmp/voice-spike-build scripts/voice-spike/build.sh
VOICE_SPIKE_HOME=/tmp/voice-spike-build scripts/voice-spike/fetch-model.sh
```

Then set the input gain and run a turn:

```
osascript -e 'set volume input volume 80'
VOICE_SPIKE_HOME=/tmp/voice-spike-build scripts/voice-spike/run-turn.sh 3
```

## Two traps this code is built around

**A mute is not an error.** With input volume at 0, every recorder exits 0 and
writes correct-length digital silence. `rms.py` treats anything below -60 dBFS
as silence and `run-turn.sh` refuses to pass it.

**`ffmpeg -f avfoundation` cannot capture from this process.** In a launchd
Background session the command blocks inside
`-[AVCaptureSession startRunning]` and never writes a file; a hand-written
AVCaptureSession gets zero callbacks. AudioQueue delivers buffers from the same
process, so `aqrec.m` is the capture layer. `ffmpeg` is still used, for PCM to
WAV, which it does fine. If the agent is ever launched in the GUI session,
`ffmpeg -f avfoundation -i ":0"` is worth retrying.

## Reading the numbers

- `speech_end` is the end of the last 20 ms window in the capture that rises
  10 dB above the median of the capture's trailing 300 ms, anchored to the
  monotonic time the capture started. It is not the player's exit: `afplay`
  exits 1.0-1.7 s after its last sample (a 0.4 s tone takes 2.7 s to "play"),
  so the player's exit would flatter every downstream number. The capture
  envelope is what the microphone heard, which is what the next stage reacts to.
- `transcript_ready` is when `whisper-cli` exited. That includes the model load,
  because this variant spawns one process per utterance.
- `first_token` is when the stub answer string was produced. It is a stub: no
  model call, no network. It measures the boundary, not an LLM.
- `first_audio` is when the `afplay` child was first observed alive, roughly
  15 ms after spawn. A 1 kHz tone recorded through the microphone became
  audible within 20-30 ms of spawn, so this proxy is close; it still proves the
  player started rather than a sample reaching the device.

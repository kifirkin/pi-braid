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
| `aqrec.m` | the capture layer (see below), with optional silence endpointing |
| `audio-device.m` | reads and sets the system default input/output device, with transport and sample rate |
| `session.py` | per-turn device/level snapshot, the marker correction, and whether a turn may be pooled |
| `turn-v1.py` | one v1 turn: resident `whisper-server`, sentence-chunked overlapping TTS |
| `run-batch.sh` | a batch across configurations, pinning and restoring gain and device pair |

Build and artifacts stay outside git under the build home (default `.work/`, ignored), which the
scripts read from an exported environment variable; export it once and every command below picks it
up.
<!-- doc-ref-exempt: environment variable read by the shell scripts here, not an identifier in a source module -->

```
scripts/voice-spike/build.sh
scripts/voice-spike/fetch-model.sh
```

Then set the input gain and run a turn:

```
osascript -e 'set volume input volume 80'
scripts/voice-spike/run-turn.sh 3
```

## Measuring a batch

`run-batch.sh` reads the input and output volume and the default device pair,
pins them for the run, and puts all four back on every exit path. Pin the
devices yourself when the machine may pick a different pair: a Bluetooth
speaker becoming default turns the microphone into its 8 kHz headset mic, and
nothing in a recording fails when that happens. The device pair, the gains and
the endpoint hangover come from the environment, and the build home as above:

```
VOICE_SPIKE_DEVICE_IN=BuiltInMicrophoneDevice \
VOICE_SPIKE_DEVICE_OUT=BuiltInSpeakerDevice \
VOICE_SPIKE_OUTPUT_GAIN=35 \
scripts/voice-spike/run-batch.sh 12 "v0 v1 v1b"
```

The build home, the device pair and both gains are the four facts a measurement
is not comparable without; the batch prints what it found and what it restored
for each of them.

`v0` is `turn.py` untouched, one `whisper-cli` per utterance. `v1` is one
resident `whisper-server` plus the reply split into sentences, the first played
while the rest synthesises. `v1b` adds capture-side silence endpointing and
wraps the PCM into a RIFF header in-process instead of forking `ffmpeg`.

Each turn records `device`, `validity.ok` and `validity.reasons`, and only ok
turns enter a percentile: a capture that recorded digital silence, a transcript
that is `[MUSIC PLAYING]`, and a marker found at 0.4 s of a 3 s capture are
all exits 0 in a harness that only looks for a non-empty string. Every latency
is reported twice, once from the 1 kHz marker and once corrected by the
marker's own span, because the marker is appended after the phrase and the
detected end is therefore not the last speech energy.

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

- `speech_end` <!-- doc-ref-exempt: JSON field name of a turn record, not a source identifier --> is the end of the last 20 ms window in the capture that rises
  10 dB above the median of the capture's trailing 300 ms, anchored to the
  monotonic time the capture started. It is not the player's exit: `afplay`
  exits 1.0-1.7 s after its last sample (a 0.4 s tone takes 2.7 s to "play"),
  so the player's exit would flatter every downstream number. The capture
  envelope is what the microphone heard, which is what the next stage reacts to.
- `transcript_ready` <!-- doc-ref-exempt: JSON field name of a turn record, not a source identifier --> is when `whisper-cli` exited. That includes the model load,
  because this variant spawns one process per utterance.
- `first_token` <!-- doc-ref-exempt: JSON field name of a turn record, not a source identifier --> is when the stub answer string was produced. It is a stub: no
  model call, no network. It measures the boundary, not an LLM.
- `first_audio` <!-- doc-ref-exempt: JSON field name of a turn record, not a source identifier --> is when the `afplay` child was first observed alive, roughly
  15 ms after spawn. A 1 kHz tone recorded through the microphone became
  audible within 20-30 ms of spawn, so this proxy is close; it still proves the
  player started rather than a sample reaching the device.

## The resident synthesiser (`avspeak.m`, `turn-v2.py`, `run-batch-v2.sh`)

`say -o` pays a fixed 800-850 ms before its first sample exists: process start
plus voice load, paid per clause and independent of length. `avspeak.m` pays it
once. It is a resident process that takes `SPEAK<TAB>text` on stdin, streams
AVSpeechSynthesizer's buffer callback into an AudioQueue, and reports the
time from reading the text to the first buffer handed to the device. A muted
warm-up utterance at startup absorbs the voice load, so no measured utterance
pays it.

Two things about that API are not obvious and both cost time to find:

- the selector is `writeUtterance:toBufferCallback:` on macOS (not `write:`);
- buffers are delivered on the main queue, so a caller that blocks the main
  thread waiting for them waits forever. `avspeak.m` runs a dispatch main queue
  and reads stdin on a second thread.

`turn-v2.py` measures the two v2 changes apart: `--tts say|resident` and
`--end window|adaptive`. `run-batch-v2.sh` pins and restores gains and devices,
harms and re-uses nothing across sessions, and prints both.

### The endpoint is still unsolved on this microphone

`aqrec.m` now carries two stopping rules: the v1 peak-relative one, and an
`adaptive:HANGOVER_MS` level-relative one that stops when the capture falls
6 dB under a decayed maximum of the recent speech level. Neither fires
reliably here: the room sits only 10-20 dB below speech, and a fixed threshold
on either side of the room draws silence and speech words from the same
distribution. Silero's ggml model, the brief's preferred instrument, could not
be used: the only ggml VAD on this machine is a test fixture, and on this input
it reports speech probabilities of 0.85-1.00 through the noise-only tail while
reporting at most 0.33 through a whole speech capture. The fixed window
therefore stays the default and every turn records `end_reason` <!-- doc-ref-exempt: JSON field name of a turn record, not a source identifier -->, so a batch
shows whether a detector fired or was merely requested.

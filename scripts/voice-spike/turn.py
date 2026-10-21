#!/usr/bin/env python3
"""One voice turn, four timestamps, one JSON object per run.

    speech end -> transcript ready -> first token of the answer -> first audio

Each boundary is read from the process that owns it. The one approximation is
`first_audio`: it is the moment the afplay child was first observed alive. `ps`
proves the player process started; it cannot see a sample reach the device, so
that number is a lower bound on audible output, not a measurement of it.

    turn.py --index 3
    turn.py --summary out/turn-*.json
"""
import array
import glob
import json
import math
import os
import statistics
import subprocess
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import measured  # noqa: E402
import rms  # noqa: E402

HOME = os.environ.get("VOICE_SPIKE_HOME", os.path.join(HERE, ".work"))
SRC = os.path.join(HOME, "whisper.cpp")
AQ = os.path.join(HOME, "aqrec")
CLI = os.path.join(SRC, "build", "bin", "whisper-cli")
MODEL = os.path.join(SRC, "models", "ggml-base.en.bin")
OUT = os.path.join(HERE, "out")

VOICE = os.environ.get("VOICE_SPIKE_VOICE", "Samantha")
RATE = os.environ.get("VOICE_SPIKE_RATE", "175")
SECONDS = float(os.environ.get("VOICE_SPIKE_SECONDS", "3"))
STIMULUS = os.environ.get(
    "VOICE_SPIKE_STIMULUS", "The quick brown fox jumps over the dog.")
REPLY = os.environ.get("VOICE_SPIKE_REPLY", "The transcript is ready.")


def synth(text: str, path: str) -> None:
    subprocess.run(["say", "-v", VOICE, "-r", RATE, "-o", path, text],
                   check=True)


def build_stimulus(text: str, path: str, marker_s: float = 0.15) -> None:
    """Phrase, then a 1 kHz marker.

    The marker is a calibration signal, not speech: it ends abruptly about 20 dB
    above this room's noise floor, so the capture can say exactly when the sound
    stopped without a threshold guess about how the last word decayed.
    """
    voice_aiff = path + ".voice.aiff"
    marker_wav = path + ".marker.wav"
    synth(text, voice_aiff)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"sine=frequency=1000:duration={marker_s}",
         "-af", "volume=8", "-ar", "16000", "-ac", "1", marker_wav],
        check=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", voice_aiff, "-i", marker_wav,
         "-filter_complex",
         "[0:a]aresample=16000,aformat=channel_layouts=mono[a];"
         "[1:a]aresample=16000,aformat=channel_layouts=mono[b];"
         "[a][b]concat=n=2:v=0:a=1",
         "-ar", "16000", "-ac", "1", path],
        check=True)


def duration_s(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        capture_output=True, text=True).stdout.strip()
    return round(float(out), 3)


def acoustic_end(path: str, freq: float = 1000.0, win_s: float = 0.02,
                 margin_db: float = -12.0, min_run: int = 3) -> dict:
    """Where the sound stopped, read from the capture at the marker's frequency.

    The stimulus ends with a 1 kHz marker. Broadband room noise that would swamp
    an RMS threshold spreads across the band, so a single-frequency detector
    (Goertzel at 1 kHz) sees the marker 20-30 dB above the same window's 1 kHz
    noise even when total RMS says otherwise. The end is the end of the last run
    of at least three 20 ms windows within 12 dB of the capture's loudest 1 kHz
    window, so the detector follows the playback volume instead of assuming one.

    tonal_snr_db is the loudest 1 kHz window against the capture's median: under
    about 10 dB there is no marker to find, and the run should be treated as
    failed rather than as a short utterance.
    """
    with wave.open(path, "rb") as w:
        rate, frames = w.getframerate(), w.getnframes()
        samples = array.array("h")
        samples.frombytes(w.readframes(frames))
        if sys.byteorder == "big":
            samples.byteswap()

    n = max(1, int(rate * win_s))
    k = int(0.5 + n * freq / rate)
    omega = 2.0 * math.pi * k / n
    coeff = 2.0 * math.cos(omega)

    levels = []
    for i in range(0, len(samples) - n + 1, n):
        s1 = s2 = 0.0
        for x in samples[i:i + n]:
            s0 = x + coeff * s1 - s2
            s2, s1 = s1, s0
        power = s1 * s1 + s2 * s2 - coeff * s1 * s2
        amp = 2.0 * math.sqrt(max(power, 0.0)) / n
        levels.append(20.0 * math.log10(amp / 32768.0) if amp > 0 else -120.0)

    peak = max(levels) if levels else -120.0
    # Digital silence gives every window the same -120 dB and would make the
    # "last run" the capture edge. No 1 kHz energy at all means no marker.
    threshold = peak + margin_db
    runs = []
    i = 0
    while peak > -60.0 and i < len(levels):
        if levels[i] > threshold:
            j = i
            while j < len(levels) and levels[j] > threshold:
                j += 1
            if j - i >= min_run:
                runs.append(j)
            i = j
        else:
            i += 1

    post = levels[runs[-1]:] if runs else levels
    median_level = statistics.median(levels) if levels else -120.0
    return {
        "method": f"last run of >={min_run} windows of {int(win_s * 1000)}ms "
                  f"with 1 kHz within {abs(margin_db):.0f} dB of its peak",
        "end_s": round(runs[-1] * win_s, 3) if runs else None,
        "threshold_db": round(threshold, 1),
        "peak_tone_db": round(peak, 1),
        "post_end_tone_max_db": round(max(post), 1) if post else None,
        "tonal_snr_db": round(peak - median_level, 1),
        "runs": len(runs),
    }


def turn(index: int) -> dict:
    os.makedirs(OUT, exist_ok=True)
    stimulus_path = os.path.join(OUT, "stimulus.wav")
    if not os.path.exists(stimulus_path):
        build_stimulus(STIMULUS, stimulus_path)

    raw = os.path.join(OUT, f"turn-{index}.pcm")
    wav = os.path.join(OUT, f"turn-{index}.wav")

    # Capture starts first so the queue is running before the stimulus plays;
    # the stimulus is pre-synthesised, so no `say` time lands inside the clock.
    t_capture_spawn = time.monotonic()
    capture = subprocess.Popen([AQ, str(SECONDS), raw],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True)
    time.sleep(0.25)
    player = subprocess.Popen(["afplay", stimulus_path])
    player.wait()
    t_player_exit = time.monotonic()
    _, capture_stderr = capture.communicate()

    aq = {}
    for line in capture_stderr.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            try:
                aq[key.strip()] = float(value)
            except ValueError:
                pass

    subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
         "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", raw,
         "-c:a", "pcm_s16le", "-y", wav], check=True)
    level = rms.analyze(wav)
    endpoint = acoustic_end(wav)

    # wav t=0 is the first sample the queue delivered, which arrived just after
    # the first buffer callback, 20 ms of audio behind it. Anchor the capture
    # clock there instead of at process spawn: the queue takes a few hundred ms
    # to warm up and using spawn would inflate every downstream delta.
    buffer_s = 0.02
    t_audio_t0 = t_capture_spawn + aq.get("first_buffer_s", 0.0) - buffer_s
    t_capture_end = t_audio_t0 + level["duration_s"]
    t_speech_end = (t_audio_t0 + endpoint["end_s"]
                    if endpoint["end_s"] is not None else t_player_exit)

    stt = measured.measure([CLI, "-m", MODEL, "-f", wav, "-nt", "-np", "-l", "en"])
    t_transcript = time.monotonic()
    transcript = stt["stdout"].strip()

    # The answer is a stub: one fixed string, no model call. Its "first token"
    # is the moment that string exists, so this stage measures the stub, not an
    # LLM. What it proves is that the boundary is reachable.
    answer = REPLY
    t_first_token = time.monotonic()

    reply_aiff = os.path.join(OUT, f"reply-{index}.aiff")
    tts = measured.measure(["say", "-v", VOICE, "-r", RATE, "-o", reply_aiff, answer])
    t_play_start = time.monotonic()
    afplay = subprocess.Popen(["afplay", reply_aiff])
    t_first_audio = None
    while t_first_audio is None and afplay.poll() is None:
        if subprocess.run(["ps", "-o", "pid=", "-p", str(afplay.pid)],
                          capture_output=True, text=True).stdout.strip():
            t_first_audio = time.monotonic()
    afplay.wait()
    t_play_end = time.monotonic()

    def ms(a, b):
        return round((b - a) * 1000.0, 1)

    return {
        "run": index,
        "stimulus": STIMULUS,
        "reply": answer,
        "capture": {
            "audio_s": level["duration_s"],
            "rms_dbfs": level["rms_dbfs"],
            "peak_dbfs": level["peak_dbfs"],
            "silent": level["silent"],
            "aqrec_started_s": round(aq.get("started_s", 0.0), 3),
            "aqrec_first_buffer_s": round(aq.get("first_buffer_s", 0.0), 3),
            "audio_t0_offset_s": round(t_audio_t0 - t_capture_spawn, 3),
        },
        "timestamps_monotonic_s": {
            "capture_spawn": round(t_capture_spawn, 4),
            "capture_audio_start": round(t_audio_t0, 4),
            "speech_end": round(t_speech_end, 4),
            "capture_audio_end": round(t_capture_end, 4),
            "player_exit": round(t_player_exit, 4),
            "transcript_ready": round(t_transcript, 4),
            "first_token": round(t_first_token, 4),
            "play_start": round(t_play_start, 4),
            "first_audio": round(t_first_audio, 4) if t_first_audio else None,
            "play_end": round(t_play_end, 4),
        },
        "speech_end": endpoint | {"source": "capture-envelope",
                                   "player_exit_lag_s": round(t_player_exit - t_speech_end, 3),
                                   "at_capture_edge": bool(
                                       endpoint["end_s"] is not None
                                       and endpoint["end_s"] > level["duration_s"] - 0.05)},
        "stages_ms": {
            "speech_end_to_transcript": ms(t_speech_end, t_transcript),
            "transcript_to_first_token": ms(t_transcript, t_first_token),
            "first_token_to_play_start": ms(t_first_token, t_play_start),
            "play_start_to_first_audio": ms(t_play_start, t_first_audio)
            if t_first_audio else None,
            "speech_end_to_first_audio": ms(t_speech_end, t_first_audio)
            if t_first_audio else None,
        },
        "stt": {
            "wall_s": stt["wall_s"],
            "peak_rss_kb": stt["peak_rss_kb"],
            "rusage_max_child_kb": stt["rusage_max_child_kb"],
            "realtime_factor": round(level["duration_s"] / stt["wall_s"], 2)
            if stt["wall_s"] else None,
            "transcript": transcript,
        },
        "tts": {
            "synthesis_s": tts["wall_s"],
            "say_peak_rss_kb": tts["peak_rss_kb"],
            "play_wall_s": round(t_play_end - t_play_start, 4),
            "reply_audio_s": duration_s(reply_aiff),
        },
    }


def summary(paths: list[str]) -> dict:
    runs = []
    for path in paths:
        with open(path) as f:
            runs.append(json.load(f))
    runs.sort(key=lambda r: r["run"])
    totals = [r["stages_ms"]["speech_end_to_first_audio"] for r in runs]
    stt_wall = [r["stt"]["wall_s"] for r in runs]
    rtf = [r["stt"]["realtime_factor"] for r in runs]
    levels = [r["capture"]["rms_dbfs"] for r in runs]
    return {
        "runs": len(runs),
        "transcripts": [r["stt"]["transcript"] for r in runs],
        "speech_end_to_first_audio_ms": {
            "values": totals, "median": statistics.median(totals)},
        "stt_wall_s": {"values": stt_wall, "median": statistics.median(stt_wall)},
        "realtime_factor": {"values": rtf, "median": statistics.median(rtf)},
        "capture_rms_dbfs": {"values": levels, "median": statistics.median(levels)},
        "peak_rss_kb": {"values": [r["stt"]["peak_rss_kb"] for r in runs],
                        "median": statistics.median([r["stt"]["peak_rss_kb"] for r in runs])},
    }


if __name__ == "__main__":
    if "--summary" in sys.argv:
        paths = []
        for arg in sys.argv[sys.argv.index("--summary") + 1:]:
            paths.extend(glob.glob(arg))
        print(json.dumps(summary(sorted(paths)), indent=2))
        sys.exit(0)
    index = int(sys.argv[sys.argv.index("--index") + 1]) if "--index" in sys.argv else 1
    result = turn(index)
    path = os.path.join(OUT, f"turn-{index}.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
    sys.exit(0 if (not result["capture"]["silent"]
                  and result["stt"]["transcript"]
                  and result["speech_end"]["end_s"] is not None
                  and result["speech_end"]["tonal_snr_db"] >= 10
                  and not result["speech_end"]["at_capture_edge"]) else 1)

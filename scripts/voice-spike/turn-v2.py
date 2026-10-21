#!/usr/bin/env python3
"""One v2 voice turn: resident synthesis, and a real endpoint on the capture.

Two changes against `turn-v1.py`, measured apart so each can be priced:

- `--tts resident` sends the reply to `avspeak`, a process started once per
  batch that has already loaded the voice, and reads its "first PCM buffer
  handed to the device" timestamp. `--tts say` is the v1 control: `say -o` per
  clause, then `afplay`, with the player child first observed alive as the
  first-audio proxy.
- `--end adaptive` asks `aqrec` for its floor-relative stop: the room floor is
  measured in the first 160 ms of the session, the stop gate sits 8 dB over it,
  and it may only fire after 300 ms of speech and 500 ms of quiet.
  `--end window` is the fixed capture window v1 used.

Capture, conversion, transcription and the four timestamps are the v1 code, so
a difference is the lever and not the instrument.

    turn-v2.py batch --turns 10 --arms say-window,resident-window,resident-adaptive
    turn-v2.py probe --turns 5      # acoustic ground truth for the synthesis leg
    turn-v2.py report say-window:out/v2-say-window-*.json ... [--primary NAME]
"""
import glob
import importlib.util
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
import rms  # noqa: E402
import session  # noqa: E402
import turn as v0  # noqa: E402

_spec = importlib.util.spec_from_file_location("turn_v1", os.path.join(HERE, "turn-v1.py"))
v1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v1)

HOME = v0.HOME
OUT = v0.OUT
AQ = os.path.join(HOME, "aqrec")
AVSPEAK = os.path.join(HOME, "avspeak")
SECONDS = float(os.environ.get("VOICE_SPIKE_SECONDS_V2", "3.2"))
PREROLL = 0.25
HANGOVER_MS = int(os.environ.get("VOICE_SPIKE_HANGOVER_MS", "500"))
ARMS = {"say-window", "say-adaptive", "resident-window", "resident-adaptive"}


class Resident:
    """The resident synthesizer as a caller sees it: one line in, one JSON out,
    and a monotonic timestamp for the moment the text was handed over."""

    def __init__(self, voice: str = v0.VOICE):
        self.proc = subprocess.Popen(
            [AVSPEAK, voice], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1)
        self.header = {}
        # avspeak prints its header only after its warm-up utterance, so
        # reading to the last header line is also the readiness barrier.
        while True:
            line = self.proc.stderr.readline()
            if not line:
                raise RuntimeError("avspeak exited during warm-up")
            line = line.strip()
            if "=" in line:
                key, _, value = line.partition("=")
                self.header[key] = value
            if line.startswith("en_us_voices="):
                break

    def speak(self, text: str) -> dict:
        clean = text.replace("\t", " ").replace("\n", " ")
        t_submit = time.monotonic()
        self.proc.stdin.write("SPEAK\t" + clean + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("avspeak produced no result")
        rec = json.loads(line)
        rec["submit"] = t_submit
        rec["done"] = time.monotonic()
        return rec

    def close(self) -> None:
        try:
            self.proc.stdin.write("QUIT\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def onset_s(wav: str, floor_ms: int = 250, enter_db: float = 10.0) -> dict:
    """First frame of sustained sound in a capture, and the floor it rose above.
    This is the one instrument here that can say a sample reached the speaker:
    the microphone heard it. Two consecutive frames above floor+10 dB, so a
    single click does not count as an onset."""
    with wave.open(wav, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        data = w.readframes(frames)
    n = rate // 50  # 20 ms
    levels = []
    for start in range(0, len(data) // 2 - n + 1, n):
        levels.append(_frame_db(data, start, n))
    if not levels:
        return {"onset_s": None, "floor_db": None, "frames": 0}
    calib = sorted(levels[: max(1, floor_ms // 20)])
    floor = calib[len(calib) // 4]
    onset = None
    for i in range(len(levels) - 1):
        if levels[i] > floor + enter_db and levels[i + 1] > floor + enter_db:
            onset = i * 0.02
            break
    return {"onset_s": onset, "floor_db": round(floor, 1), "frames": len(levels),
            "peak_db": round(max(levels), 1)}


def _frame_db(data: bytes, offset: int, frames: int) -> float:
    import array
    a = array.array("h")
    a.frombytes(data[offset * 2:(offset + frames) * 2])
    energy = sum(x * x for x in a)
    rms_v = math.sqrt(energy / len(a)) / 32768.0 if a else 0.0
    return 20.0 * math.log10(rms_v) if rms_v > 0 else -120.0


def turn(index: int, arm: str, port: int, resident: Resident | None) -> dict:
    if arm not in ARMS:
        raise SystemExit(f"unknown arm {arm!r}")
    tts_kind, end_kind = arm.split("-")
    if tts_kind == "resident" and resident is None:
        raise SystemExit("resident arm needs a resident synthesizer")
    os.makedirs(OUT, exist_ok=True)
    stimulus_path = os.path.join(OUT, "stimulus.wav")
    if not os.path.exists(stimulus_path):
        v0.build_stimulus(v0.STIMULUS, stimulus_path)

    environment = session.snapshot()
    meta = session.stimulus_meta(stimulus_path)
    raw = os.path.join(OUT, f"cap-v2-{arm}-{index}.pcm")
    wav = os.path.join(OUT, f"cap-v2-{arm}-{index}.wav")

    end_arg = [f"adaptive:{HANGOVER_MS}"] if end_kind == "adaptive" else []
    t_capture_spawn = time.monotonic()
    capture = subprocess.Popen(
        [AQ, str(SECONDS), raw] + end_arg,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(PREROLL)
    player = subprocess.Popen(["afplay", stimulus_path])
    player.wait()
    t_player_exit = time.monotonic()
    _, capture_stderr = capture.communicate()
    t_capture_done = time.monotonic()

    aq = {}
    for line in capture_stderr.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            try:
                aq[key.strip()] = float(value)
            except ValueError:
                aq[key.strip()] = value

    conversion = {"tool": "wave", "ms": v1.wrap_wav(raw, wav)}
    t_converted = time.monotonic()

    stt = v1.server_post(wav, port)
    t_transcript = time.monotonic()

    answer = v0.REPLY
    t_first_token = time.monotonic()

    level = rms.analyze(wav)
    endpoint = v0.acoustic_end(wav)

    buffer_s = 0.02
    t_audio_t0 = t_capture_spawn + aq.get("first_buffer_s", 0.0) - buffer_s
    t_speech_end = (t_audio_t0 + endpoint["end_s"]
                    if endpoint["end_s"] is not None else t_player_exit)

    if tts_kind == "say":
        parts = v1.clauses(answer)
        play = v1.play_chunked(parts, index)
        first_audio = play["first_audio"]
        tts = {"player": "say+afplay"} | play
    else:
        parts = [answer]
        rec = resident.speak(answer)
        # The instrument is avspeak's own "first buffer handed to the device",
        # anchored to the monotonic time the text line was written. The probe
        # makes the same measurement with a microphone.
        first_audio = (rec["submit"] + rec["first_enqueue_ms"] / 1000.0
                       if rec.get("first_enqueue_ms", -1) >= 0 else None)
        tts = {"player": "avspeak", "result": {
            k: v for k, v in rec.items() if k not in ("submit", "done")},
            "submit_ms": round((rec["submit"] - t_first_token) * 1000.0, 1)}

    def ms(a, b):
        return round((b - a) * 1000.0, 1)

    record = {
        "run": index,
        "config": arm,
        "stimulus": v0.STIMULUS,
        "stimulus_sha256": meta["sha256"],
        "stimulus_duration_s": meta["duration_s"],
        "marker_s": meta["marker_s"],
        "device": environment,
        "reply": answer,
        "clauses": parts,
        "capture": {
            "audio_s": level["duration_s"],
            "rms_dbfs": level["rms_dbfs"],
            "peak_dbfs": level["peak_dbfs"],
            "silent": level["silent"],
            "aqrec_first_buffer_s": round(aq.get("first_buffer_s", 0.0), 3),
            "window_s": SECONDS,
            "preroll_s": PREROLL,
        },
        "endpointing": {
            "enabled": end_kind == "adaptive",
            "end_ms": HANGOVER_MS if end_kind == "adaptive" else 0,
            "mode": "adaptive-floor" if end_kind == "adaptive" else "window",
            "floor_db": aq.get("floor_db"),
            "peak_db": aq.get("peak_db"),
            "gate_db": aq.get("gate_db"),
            "enter_db": aq.get("enter_db"),
            "armed": aq.get("armed"),
            "speech_frames": aq.get("speech_frames"),
            "quiet_frames": aq.get("quiet_frames"),
            "stop_s": aq.get("stop_s"),
            "end_reason": aq.get("end_reason"),
        },
        "clipping": {
            "capture_s": level["duration_s"],
            "stimulus_s": meta["duration_s"],
            "expected_min_s": round(meta["duration_s"] - 0.1, 3),
            "clipped": bool(level["duration_s"] < meta["duration_s"] - 0.1),
            "speech_end_s": endpoint["end_s"],
            "ends_before_stimulus_ms": (round((meta["duration_s"] - endpoint["end_s"]) * 1000.0, 1)
                                        if endpoint["end_s"] is not None else None),
        },
        "conversion": conversion,
        "timestamps_monotonic_s": {
            "capture_spawn": round(t_capture_spawn, 4),
            "capture_audio_start": round(t_audio_t0, 4),
            "speech_end": round(t_speech_end, 4),
            "player_exit": round(t_player_exit, 4),
            "transcript_ready": round(t_transcript, 4),
            "first_token": round(t_first_token, 4),
            "first_audio": round(first_audio, 4) if first_audio else None,
        },
        "speech_end": endpoint | {
            "source": "capture-envelope",
            "player_exit_lag_s": round(t_player_exit - t_speech_end, 3),
            "capture_tail_s": (round(level["duration_s"] - endpoint["end_s"], 3)
                               if endpoint["end_s"] is not None else None),
            "recorder_exit_lag_ms": round(
                (t_capture_done - (t_audio_t0 + level["duration_s"])) * 1000.0, 1),
            "at_capture_edge": bool(endpoint["end_s"] is not None and
                                    endpoint["end_s"] > level["duration_s"] - 0.05),
        },
        "stages_ms": {
            "speech_end_to_transcript": ms(t_speech_end, t_transcript),
            "capture_end_to_converted": ms(t_capture_done, t_converted),
            "speech_end_to_converted": ms(t_speech_end, t_converted),
            "stt_request": stt["request_ms"],
            "transcript_to_first_token": ms(t_transcript, t_first_token),
            "first_token_to_first_audio": ms(t_first_token, first_audio) if first_audio else None,
            "speech_end_to_first_audio": ms(t_speech_end, first_audio) if first_audio else None,
        },
        "stt": {
            "transport": "whisper-server",
            "request_ms": stt["request_ms"],
            "transcript": stt["text"],
        },
        "tts": tts | {"voice": v0.VOICE, "rate": v0.RATE},
    }
    session.verdict(record, meta)
    path = os.path.join(OUT, f"v2-{arm}-{index}.json")
    with open(path, "w") as f:
        json.dump(record, f, indent=2)
    return record


def summary_row(r: dict) -> dict:
    v = r.get("validity") or {}
    ep = r.get("endpointing") or {}
    clip = r.get("clipping") or {}
    tts = r.get("tts") or {}
    if tts.get("player") == "avspeak":
        first_synth = tts.get("result", {}).get("first_enqueue_ms")
    else:
        chunks = tts.get("chunks") or []
        first_synth = chunks[0].get("synth_ms") if chunks else None
    return {
        "config": r["config"], "run": r["run"], "ok": bool(v.get("ok")),
        "reasons": v.get("reasons", []), "rms_dbfs": r["capture"]["rms_dbfs"],
        "speech_end_s": r["speech_end"]["end_s"],
        "capture_s": r["capture"]["audio_s"],
        "end_reason": ep.get("end_reason"), "floor_db": ep.get("floor_db"),
        "gate_db": ep.get("gate_db"), "armed": ep.get("armed"),
        "clipped": clip.get("clipped"),
        "ends_before_stimulus_ms": clip.get("ends_before_stimulus_ms"),
        "stt_ms": r["stt"].get("request_ms"),
        "first_synth_ms": first_synth,
        "total_ms": r["stages_ms"]["speech_end_to_first_audio"],
        "corrected_ms": r["stages_ms"].get("speech_end_to_first_audio_corrected"),
        "transcript": r["stt"]["transcript"],
        "wer": v.get("wer"),
    }


def report(specs: list[str], primary: str | None) -> dict:
    groups = {}
    for spec in specs:
        label, _, pattern = spec.partition(":")
        runs = []
        for path in sorted(glob.glob(pattern)):
            with open(path) as f:
                runs.append(json.load(f))
        if not runs:
            print(f"report: no turns matched {pattern!r}", file=sys.stderr)
        else:
            groups[label] = sorted(runs, key=lambda r: (r["run"], r["config"]))

    out = {"rows": {}, "summary": {}, "stimulus_sha256": {}, "machine": {}}
    for label, runs in groups.items():
        rows = [summary_row(r) for r in runs]
        good = [r for r in runs if (r.get("validity") or {}).get("ok")]
        totals = [r["stages_ms"]["speech_end_to_first_audio"] for r in good]
        corrected = [r["stages_ms"]["speech_end_to_first_audio_corrected"] for r in good]
        ends = [r["endpointing"].get("end_reason") for r in runs]
        out["rows"][label] = rows
        out["summary"][label] = {
            "turns": len(runs), "turns_ok": len(good),
            "turns_failed": len(runs) - len(good),
            "p50_ms": round(statistics.median(totals), 1) if totals else None,
            "p90_ms": round(v1.pct(totals, 0.9), 1) if totals else None,
            "p50_corrected_ms": (round(statistics.median(corrected), 1)
                                 if corrected else None),
            "p90_corrected_ms": round(v1.pct(corrected, 0.9), 1) if corrected else None,
            "marker_correction_ms": round((good[0]["marker_s"] if good else 0.0) * 1000.0, 1),
            "end_reasons": {k: ends.count(k) for k in sorted(set(ends), key=str)},
            "clipped_turns": sum(1 for r in runs
                                 if (r.get("clipping") or {}).get("clipped")),
            "stt_median_ms": round(statistics.median([x["stt_ms"] for x in rows]), 1)
            if rows else None,
            "first_synth_median_ms": round(statistics.median(
                [x["first_synth_ms"] for x in rows
                 if x["first_synth_ms"] is not None]), 1) if rows else None,
            "exact_transcripts": sum(1 for x in rows if x["wer"] == 0.0),
        }
        out["stimulus_sha256"][label] = sorted(
            {r.get("stimulus_sha256") for r in runs} - {None})
        dev = runs[0].get("device") if runs else None
        if dev:
            out["machine"][label] = {
                "input": dev.get("input"), "output": dev.get("output"),
                "levels": dev.get("levels"),
                "device_identical_across_turns": all(
                    (r.get("device") or {}).get("input") == dev.get("input") and
                    (r.get("device") or {}).get("output") == dev.get("output")
                    for r in runs),
            }
    if primary and primary in out["summary"]:
        p50 = out["summary"][primary]["p50_corrected_ms"]
        out["decision"] = {
            "config": primary,
            "basis": "p50 of speech_end_to_first_audio_corrected over ok turns",
            "p50_ms": p50,
            "bar_ms": 1500,
            "verdict": ("the local channel meets the conversational bar"
                        if p50 is not None and p50 <= 1500
                        else "the local channel is accepted at its measured p50"),
            "rule": "p50 <= 1500 ms meets the bar; above it the local channel is "
                    "accepted at whatever it measures",
        }
    return out


def probe(turns: int, voice: str) -> dict:
    """Acoustic ground truth for the synthesis leg: the resident process is
    asked to speak while a microphone records, and the onset in that recording
    is compared with the internal first-buffer timestamp."""
    resident = Resident(voice)
    rows = []
    try:
        for i in range(1, turns + 1):
            raw = os.path.join(OUT, f"probe-{i}.pcm")
            wav = os.path.join(OUT, f"probe-{i}.wav")
            spawn = time.monotonic()
            rec_proc = subprocess.Popen([AQ, "1.6", raw],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True)
            time.sleep(0.3)
            res = resident.speak(v0.REPLY)
            t_submit = res["submit"]
            _, err = rec_proc.communicate()
            aq = {}
            for line in err.splitlines():
                if "=" in line:
                    k, _, val = line.partition("=")
                    try:
                        aq[k.strip()] = float(val)
                    except ValueError:
                        pass
            v1.wrap_wav(raw, wav)
            on = onset_s(wav)
            t_audio_t0 = spawn + aq.get("first_buffer_s", 0.0) - 0.02
            acoustic_ms = (round((t_audio_t0 + on["onset_s"] - t_submit) * 1000.0, 1)
                           if on["onset_s"] is not None else None)
            rows.append({
                "run": i,
                "internal_first_enqueue_ms": res.get("first_enqueue_ms"),
                "internal_first_synth_ms": res.get("synth_first_ms"),
                "acoustic_onset_ms": acoustic_ms,
                "acoustic_minus_internal_ms": (
                    round(acoustic_ms - res["first_enqueue_ms"], 1)
                    if acoustic_ms is not None else None),
                "onset_s": on["onset_s"], "floor_db": on["floor_db"],
                "peak_db": on["peak_db"], "rms_dbfs": rms.analyze(wav)["rms_dbfs"],
                "audio_ms": res.get("audio_ms"),
            })
    finally:
        resident.close()
    deltas = [r["acoustic_minus_internal_ms"] for r in rows
              if r["acoustic_minus_internal_ms"] is not None]
    return {
        "turns": rows,
        "internal_median_ms": round(statistics.median(
            [r["internal_first_enqueue_ms"] for r in rows]), 1),
        "acoustic_median_ms": round(statistics.median(
            [r["acoustic_onset_ms"] for r in rows
             if r["acoustic_onset_ms"] is not None]), 1) if deltas else None,
        "delta_median_ms": round(statistics.median(deltas), 1) if deltas else None,
        "header": resident.header,
    }


def batch(turns: int, arms: list[str], port: int) -> dict:
    resident = Resident() if any(a.startswith("resident") for a in arms) else None
    results = {}
    try:
        for arm in arms:
            recs = []
            for i in range(1, turns + 1):
                recs.append(turn(i, arm, port, resident))
                row = summary_row(recs[-1])
                print(json.dumps({k: row[k] for k in
                                  ("config", "run", "ok", "reasons", "end_reason",
                                   "rms_dbfs", "speech_end_s", "clipped",
                                   "first_synth_ms", "total_ms", "corrected_ms",
                                   "transcript")}))
                sys.stdout.flush()
            results[arm] = len(recs)
    finally:
        if resident:
            print(json.dumps({"avspeak_header": resident.header}))
            resident.close()
    return results


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    port = int(os.environ.get("VOICE_SPIKE_SERVER_PORT", "18901"))
    if args[0] == "batch":
        turns_n = 10
        arms = ["say-window", "resident-window", "resident-adaptive"]
        for i, a in enumerate(args[1:]):
            if a == "--turns":
                turns_n = int(args[i + 2])
            elif a == "--arms":
                arms = args[i + 2].split(",")
            elif a == "--port":
                port = int(args[i + 2])
        print(json.dumps(batch(turns_n, arms, port)))
    elif args[0] == "probe":
        turns_n = int(args[args.index("--turns") + 1]) if "--turns" in args else 5
        print(json.dumps(probe(turns_n, v0.VOICE), indent=2))
    elif args[0] == "report":
        specs, primary = [], None
        rest = args[1:]
        i = 0
        while i < len(rest):
            if rest[i] == "--primary":
                primary = rest[i + 1]
                i += 2
            else:
                specs.append(rest[i])
                i += 1
        print(json.dumps(report(specs, primary), indent=2))
    else:
        raise SystemExit(__doc__)

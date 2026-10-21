#!/usr/bin/env python3
"""One v1 voice turn: resident STT, chunked overlapping TTS, four timestamps.

Same four boundaries as `turn.py`, read the same way, so the two are
comparable:

    speech end -> transcript ready -> first token -> first audio

Two differences, both levers rather than instruments:

- transcription is an HTTP request to a `whisper-server` started once per
  batch, so the model is loaded once per session instead of once per utterance;
- the reply is split into sentences, the first sentence is synthesised and
  played while the rest is still being synthesised, so the whole reply is not
  paid for before the first sound.

`--config v1` keeps the v0 capture and conversion exactly (fixed window,
`ffmpeg` for PCM to WAV) so the delta against v0 is the two levers and nothing
else. `--config v1b` adds the two reductions v0's own decomposition named: the
capture stops 300 ms after speech instead of running out a fixed window, and
the PCM is wrapped into a RIFF header in-process instead of by forking
`ffmpeg`. Both are measured and reported per turn.

    turn-v1.py --index 3 --config v1b --port 18901
    turn-v1.py summary out/v1-*.json
"""
import glob
import hashlib
import http.client
import json
import math
import os
import re
import statistics
import subprocess
import sys
import time
import uuid
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import measured  # noqa: E402
import rms  # noqa: E402
import session  # noqa: E402
import turn as v0  # noqa: E402

OUT = v0.OUT
AQ = v0.AQ
VOICE = v0.VOICE
RATE = v0.RATE
SECONDS = v0.SECONDS
STIMULUS = v0.STIMULUS
REPLY = v0.REPLY

END_MS = int(os.environ.get("VOICE_SPIKE_END_MS", "300"))
PORT = int(os.environ.get("VOICE_SPIKE_SERVER_PORT", "18901"))
HOST = "127.0.0.1"
CONFIGS = ("v1", "v1b")


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def clauses(text: str) -> list[str]:
    """The reply as sentences: the unit the first sound is paid for."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p.strip()]
    return parts or [text.strip()]


def server_post(wav: str, port: int, timeout: float = 120.0) -> dict:
    """One resident-server request. The body is built here, not by curl, so the
    only cost inside the measured window is the request and the inference."""
    boundary = uuid.uuid4().hex
    with open(wav, "rb") as f:
        audio = f.read()
    fields = (("language", "en"), ("response_format", "json"),
              ("temperature", "0.0"))
    body = b"".join(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        for k, v in fields)
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"turn.wav\"\r\nContent-Type: audio/wav\r\n\r\n").encode()
    body += audio + b"\r\n" + f"--{boundary}--\r\n".encode()

    conn = http.client.HTTPConnection(HOST, port, timeout=timeout)
    t0 = time.monotonic()
    conn.request("POST", "/inference", body=body,
                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                          "Content-Length": str(len(body))})
    resp = conn.getresponse()
    raw = resp.read()
    t1 = time.monotonic()
    conn.close()
    if resp.status != 200:
        raise RuntimeError(f"server status {resp.status}: {raw[:200]!r}")
    return {"request_ms": round((t1 - t0) * 1000.0, 1),
            "text": json.loads(raw).get("text", "").strip()}


def wrap_wav(pcm: str, wav: str) -> float:
    """s16le 16 kHz mono plus a RIFF header: what `ffmpeg -c:a pcm_s16le` does,
    without forking a process to do it."""
    t0 = time.monotonic()
    with open(pcm, "rb") as f:
        data = f.read()
    with wave.open(wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(data)
    return round((time.monotonic() - t0) * 1000.0, 1)


def ffmpeg_wav(pcm: str, wav: str) -> float:
    t0 = time.monotonic()
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
         "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", pcm,
         "-c:a", "pcm_s16le", "-y", wav], check=True)
    return round((time.monotonic() - t0) * 1000.0, 1)


def synth(text: str, path: str) -> dict:
    return measured.measure(["say", "-v", VOICE, "-r", RATE, "-o", path, text])


def play_chunked(parts: list[str], index: int) -> dict:
    """Synthesise the first sentence, start it, and pay for the next one while
    it plays. `first_audio` is the same instrument as v0: the player child
    first observed alive. It proves the player started; it cannot prove a
    sample reached the device."""
    chunks = []
    next_aiff = None
    next_synth_ms = None
    first_audio = None
    for i, text in enumerate(parts):
        if next_aiff is None:
            aiff = os.path.join(OUT, f"reply-{index}-{i}.aiff")
            synth_ms = round(synth(text, aiff)["wall_s"] * 1000.0, 1)
        else:
            aiff, synth_ms = next_aiff, next_synth_ms
            next_aiff = None
        t_play = time.monotonic()
        player = subprocess.Popen(["afplay", aiff])
        first_seen = None
        while first_seen is None and player.poll() is None:
            if subprocess.run(["ps", "-o", "pid=", "-p", str(player.pid)],
                              capture_output=True, text=True).stdout.strip():
                first_seen = time.monotonic()
        if first_audio is None:
            first_audio = first_seen
        if i + 1 < len(parts):
            nxt = os.path.join(OUT, f"reply-{index}-{i + 1}.aiff")
            next_aiff, next_synth_ms = nxt, round(synth(parts[i + 1], nxt)["wall_s"] * 1000.0, 1)
        player.wait()
        t_end = time.monotonic()
        chunks.append({
            "text": text,
            "synth_ms": synth_ms,
            "play_wall_s": round(t_end - t_play, 4),
            "audio_s": v0.duration_s(aiff),
            "first_audio_lag_ms": round((first_seen - t_play) * 1000.0, 1) if first_seen else None,
            "play_start": t_play,
            "play_end": t_end,
        })
    for i in range(1, len(chunks)):
        chunks[i]["gap_before_ms"] = round(
            (chunks[i]["play_start"] - chunks[i - 1]["play_end"]) * 1000.0, 1)
    for c in chunks:
        c.pop("play_start", None)
        c.pop("play_end", None)
    return {"chunks": chunks, "first_audio": first_audio}


def turn(index: int, config: str = "v1", port: int = PORT) -> dict:
    if config not in CONFIGS:
        raise SystemExit(f"unknown config {config!r}; expected one of {CONFIGS}")
    os.makedirs(OUT, exist_ok=True)
    stimulus_path = os.path.join(OUT, "stimulus.wav")
    if not os.path.exists(stimulus_path):
        v0.build_stimulus(STIMULUS, stimulus_path)

    # Recorded, not assumed: the device pair, the gain, and the stimulus file
    # this turn actually played. A turn without them cannot be compared.
    environment = session.snapshot()
    meta = session.stimulus_meta(stimulus_path)

    raw = os.path.join(OUT, f"cap-{config}-{index}.pcm")
    wav = os.path.join(OUT, f"cap-{config}-{index}.wav")

    # Same spawn order as v0: the queue runs before the stimulus plays, and the
    # stimulus is pre-synthesised so no synthesis time lands inside the clock.
    t_capture_spawn = time.monotonic()
    cmd = [AQ, str(SECONDS), raw] + ([str(END_MS)] if config == "v1b" else [])
    capture = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True)
    time.sleep(0.25)
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

    if config == "v1b":
        conversion = {"tool": "wave", "ms": wrap_wav(raw, wav)}
    else:
        conversion = {"tool": "ffmpeg", "ms": ffmpeg_wav(raw, wav)}
    t_converted = time.monotonic()

    # The request goes first. The harness's own bookkeeping (level, envelope)
    # is not part of the path a user waits on, so it runs after the turn's work
    # instead of inside the measured window.
    stt = server_post(wav, port)
    t_transcript = time.monotonic()

    # Same stub as v0: one fixed string, no model call. Its first token is the
    # moment that string exists, so this stage measures the boundary, not an LLM.
    answer = REPLY
    t_first_token = time.monotonic()

    level = rms.analyze(wav)
    endpoint = v0.acoustic_end(wav)
    t_analysed = time.monotonic()

    # The capture clock is anchored at the first delivered sample, not at
    # process spawn: the queue warms up in a few hundred ms and spawn time
    # would inflate every downstream delta.
    buffer_s = 0.02
    t_audio_t0 = t_capture_spawn + aq.get("first_buffer_s", 0.0) - buffer_s
    t_speech_end = (t_audio_t0 + endpoint["end_s"]
                    if endpoint["end_s"] is not None else t_player_exit)

    parts = clauses(answer)
    play = play_chunked(parts, index)
    t_first_audio = play["first_audio"]

    def ms(a, b):
        return round((b - a) * 1000.0, 1)

    return {
        "run": index,
        "config": config,
        "stimulus": STIMULUS,
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
        },
        "endpointing": {
            "enabled": config == "v1b",
            "end_ms": END_MS if config == "v1b" else 0,
            "noise_db": aq.get("noise_db"),
            "peak_db": aq.get("peak_db"),
            "gate_db": aq.get("gate_db"),
            "speech_frames": aq.get("speech_frames"),
            "quiet_frames": aq.get("quiet_frames"),
            "stop_s": aq.get("stop_s"),
            "end_reason": aq.get("end_reason"),
        },
        "conversion": conversion,
        "timestamps_monotonic_s": {
            "capture_spawn": round(t_capture_spawn, 4),
            "capture_audio_start": round(t_audio_t0, 4),
            "speech_end": round(t_speech_end, 4),
            "player_exit": round(t_player_exit, 4),
            "transcript_ready": round(t_transcript, 4),
            "first_token": round(t_first_token, 4),
            "first_audio": round(t_first_audio, 4) if t_first_audio else None,
        },
        "speech_end": endpoint | {
            "source": "capture-envelope",
            "player_exit_lag_s": round(t_player_exit - t_speech_end, 3),
            "capture_tail_s": round(level["duration_s"] - endpoint["end_s"], 3)
            if endpoint["end_s"] is not None else None,
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
            "harness_analysis_after_transcript": ms(t_transcript, t_analysed),
            "transcript_to_first_token": ms(t_transcript, t_first_token),
            "first_token_to_first_audio": ms(t_first_token, t_first_audio) if t_first_audio else None,
            "speech_end_to_first_audio": ms(t_speech_end, t_first_audio) if t_first_audio else None,
        },
        "stt": {
            "transport": "whisper-server",
            "request_ms": stt["request_ms"],
            "transcript": stt["text"],
        },
        "tts": play | {"voice": VOICE, "rate": RATE},
    }


def pct(values: list[float], p: float) -> float:
    """Nearest-rank percentile: the value at ceil(p*n) in sorted order."""
    ordered = sorted(values)
    k = max(1, math.ceil(len(ordered) * p))
    return ordered[min(k, len(ordered)) - 1]


def norm_words(text: str) -> list[str]:
    return session.norm_words(text)


def word_error_rate(reference: str, hypothesis: str) -> float:
    return session.word_error_rate(reference, hypothesis)


def report(specs: list[str]) -> dict:
    """Per-turn tables and the p50/p90 comparison, generated from the run JSON
    rather than retyped, so the decision line cannot drift from the numbers."""
    groups = {}
    for spec in specs:
        label, _, pattern = spec.partition(":")
        paths = sorted(glob.glob(pattern))
        runs = []
        for path in paths:
            with open(path) as f:
                runs.append(json.load(f))
        if runs:
            groups[label] = sorted(runs, key=lambda r: r["run"])
        else:
            print("report: no turns matched %r" % pattern, file=sys.stderr)

    out = {"turn_rows": {}, "summary": {}, "stimulus_sha256": {}, "machine": {}}
    for label, runs in groups.items():
        rows = []
        for r in runs:
            tts = r.get("tts", {})
            first_synth = (tts.get("chunks", [{}])[0].get("synth_ms")
                           if tts.get("chunks") else
                           round(tts.get("synthesis_s", 0.0) * 1000.0, 1))
            validity = r.get("validity") or {}
            rows.append({
                "run": r["run"],
                "ok": bool(validity.get("ok")),
                "reasons": validity.get("reasons", ["no validity record"]),
                "rms_dbfs": r["capture"]["rms_dbfs"],
                "speech_end_s": r["speech_end"]["end_s"],
                "stt_ms": (r["stt"].get("request_ms") if "request_ms" in r["stt"]
                           else round(r["stt"]["wall_s"] * 1000.0, 1)),
                "first_synth_ms": first_synth,
                "first_audio_ms": r["stages_ms"]["speech_end_to_first_audio"],
                "corrected_ms": r["stages_ms"].get("speech_end_to_first_audio_corrected"),
                "transcript": r["stt"]["transcript"],
                "wer": validity.get(
                    "wer", word_error_rate(r["stimulus"], r["stt"]["transcript"])),
            })

        good = [r for r in runs if (r.get("validity") or {}).get("ok")]
        totals = [r["stages_ms"]["speech_end_to_first_audio"] for r in good]
        corrected = [r["stages_ms"].get("speech_end_to_first_audio_corrected") for r in good]
        marker = good[0].get("marker_s") if good else None
        out["turn_rows"][label] = rows
        out["summary"][label] = {
            "turns": len(runs),
            "turns_ok": len(good),
            "turns_failed": len(runs) - len(good),
            "p50_ms": round(statistics.median(totals), 1) if totals else None,
            "p90_ms": round(pct(totals, 0.9), 1) if totals else None,
            "min_ms": min(totals) if totals else None,
            "max_ms": max(totals) if totals else None,
            "p50_corrected_ms": round(statistics.median(corrected), 1) if corrected else None,
            "p90_corrected_ms": round(pct(corrected, 0.9), 1) if corrected else None,
            "marker_correction_ms": round((marker or 0.0) * 1000.0, 1),
            "stt_median_ms": round(statistics.median(
                [x["stt_ms"] for x in rows]), 1) if rows else None,
            "exact_transcripts": sum(1 for x in rows if x["wer"] == 0.0),
            "median_wer": round(statistics.median([x["wer"] for x in rows]), 3)
            if rows else None,
        }
        out["stimulus_sha256"][label] = sorted({r.get("stimulus_sha256") for r in runs} - {None})
        device = runs[0].get("device") if runs else None
        if device:
            out["machine"][label] = {
                "input": device.get("input"),
                "output": device.get("output"),
                "levels": device.get("levels"),
                "device_identical_across_turns": all(
                    (r.get("device") or {}).get("input") == device.get("input") and
                    (r.get("device") or {}).get("output") == device.get("output")
                    for r in runs),
            }

    out["stimulus_file_now"] = sha256(os.path.join(OUT, "stimulus.wav"))
    primary = "v1b" in groups and out["summary"]["v1b"]["p50_corrected_ms"] is not None
    if primary:
        p50 = out["summary"]["v1b"]["p50_corrected_ms"]
        out["decision"] = {
            "config": "v1b",
            "basis": "p50 of speech_end_to_first_audio_corrected over ok turns",
            "p50_ms": p50,
            "bar_ms": 1500,
            "verdict": ("local road kept" if p50 <= 1500 else "hosted realtime API wins"),
            "rule": "p50 <= 1500 ms keeps the local road",
        }
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "report":
        print(json.dumps(report(args[1:]), indent=2))
        sys.exit(0)
    if args and args[0] == "summary":
        paths = [p for a in args[1:] for p in (glob.glob(a) or [a])]
        runs = []
        for path in paths:
            with open(path) as f:
                runs.append(json.load(f))
        runs.sort(key=lambda r: (r["config"], r["run"]))
        good = [r for r in runs if (r.get("validity") or {}).get("ok")]
        totals = [r["stages_ms"]["speech_end_to_first_audio"] for r in good]
        corrected = [r["stages_ms"].get("speech_end_to_first_audio_corrected") for r in good]
        print(json.dumps({
            "turns": len(runs),
            "turns_ok": len(good),
            "turns_failed": len(runs) - len(good),
            "failed_turns": [
                {"config": r["config"], "run": r["run"],
                 "reasons": (r.get("validity") or {}).get("reasons")}
                for r in runs if not (r.get("validity") or {}).get("ok")],
            "configs": sorted({r["config"] for r in runs}),
            "stimulus_sha256": sorted({r["stimulus_sha256"] for r in runs}),
            "speech_end_to_first_audio_ms": {
                "values": totals,
                "p50": round(statistics.median(totals), 1) if totals else None,
                "p90": round(pct(totals, 0.9), 1) if totals else None,
            },
            "speech_end_to_first_audio_corrected_ms": {
                "values": corrected,
                "p50": round(statistics.median(corrected), 1) if corrected else None,
                "p90": round(pct(corrected, 0.9), 1) if corrected else None,
            },
        }, indent=2))
        sys.exit(0)
    config = args[args.index("--config") + 1] if "--config" in args else "v1"
    port = int(args[args.index("--port") + 1]) if "--port" in args else PORT
    index = int(args[args.index("--index") + 1]) if "--index" in args else 1
    result = turn(index, config, port)
    meta = session.stimulus_meta(os.path.join(OUT, "stimulus.wav"))
    session.verdict(result, meta)
    with open(os.path.join(OUT, f"v1-{config}-{index}.json"), "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["validity"]["ok"] else 1)

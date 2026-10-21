#!/usr/bin/env python3
"""Facts about the session a turn ran in, and whether that turn may be pooled.

Three things the first spike left unrecorded, each of which makes a number
incomparable rather than merely imprecise:

- which devices the audio went through. A Bluetooth speaker at 8 kHz and a
  built-in microphone at 48 kHz are different acoustic paths, and macOS swaps
  the default pair on its own;
- whether the turn is fit to be pooled at all. A recorder that returned zeros,
  a hallucinated transcript and a marker-detected "speech end" of 0.24 s in a
  3 s capture are all exits 0 in a harness that only checks for a non-empty
  string;
- how much of the marker-based speech end is not speech. `build_stimulus`
  appends a 1 kHz calibration tone after the phrase, so the detected end is
  later than the last speech energy by the tone's own duration. That offset is
  measured here and reported next to every latency, because the rule has to be
  applied to the figure a human would experience.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.environ.get("VOICE_SPIKE_HOME", os.path.join(HERE, ".work"))
DEVICE_BIN = os.environ.get("VOICE_SPIKE_AUDIO_DEVICE", os.path.join(HOME, "audio-device"))

sys.path.insert(0, HERE)


def _parse(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        key, _, value = line.partition("=")
        if key:
            out[key.strip()] = value.strip()
    for key in ("sample_rate", "channels"):
        if key in out:
            try:
                out[key] = int(float(out[key]))
            except ValueError:
                pass
    return out


def device(direction: str) -> dict:
    """The default device for `in` or `out`, as the HAL reports it right now."""
    if not os.access(DEVICE_BIN, os.X_OK):
        return {"error": f"no {DEVICE_BIN}; compile audio-device.m"}
    proc = subprocess.run([DEVICE_BIN, "get", direction], capture_output=True, text=True)
    info = _parse(proc.stdout)
    info["exit"] = proc.returncode
    return info


def levels() -> dict:
    """System input and output gain. Per device: macOS keeps one value each."""
    proc = subprocess.run(["osascript", "-e", "get volume settings"],
                          capture_output=True, text=True)
    out = {}
    for part in proc.stdout.strip().split(","):
        key, _, value = part.partition(":")
        out[key.strip().replace(" ", "_")] = value.strip()
    return out


def snapshot() -> dict:
    return {"input": device("in"), "output": device("out"), "levels": levels()}


def stimulus_meta(path: str) -> dict:
    """Duration and the marker's own span, so the correction is measured from
    the file that was actually played rather than assumed."""
    import hashlib
    import turn

    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    span = turn.acoustic_end(path)
    duration = turn.duration_s(path)
    marker_s = (round(span["end_s"] - span["start_s"], 3)
                if span.get("start_s") is not None else None)
    return {"path": path, "sha256": digest.hexdigest(), "duration_s": duration,
            "marker_start_s": span.get("start_s"), "marker_end_s": span.get("end_s"),
            "marker_s": marker_s, "duration_rounded": duration}


def norm_words(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9 ]", " ", text.lower()).split()


def word_error_rate(reference: str, hypothesis: str) -> float:
    import difflib

    ref, hyp = norm_words(reference), norm_words(hypothesis)
    if not ref:
        return 0.0
    sm = difflib.SequenceMatcher(a=ref, b=hyp, autojunk=False)
    errors = sum(max(i2 - i1, j2 - j1)
                 for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal")
    return round(errors / len(ref), 3)


def verdict(record: dict, meta: dict, tolerance_s: float = 0.4) -> dict:
    """Whether this turn may enter a summary, and if not, why not."""
    reasons = []
    transcript = (record["stt"].get("transcript") or "").strip()
    if record["capture"].get("silent"):
        reasons.append("capture is digital silence")
    if not transcript:
        reasons.append("empty transcript")
    elif re.fullmatch(r"[\[(].*[\])]", transcript):
        reasons.append(f"transcript is a non-speech marker: {transcript!r}")
    end = record["speech_end"].get("end_s")
    if end is None:
        reasons.append("no 1 kHz marker in the capture")
    else:
        if (record["speech_end"].get("tonal_snr_db") or 0) < 10:
            reasons.append("marker SNR below 10 dB")
        if record["speech_end"].get("at_capture_edge"):
            reasons.append("marker runs to the capture edge")
        if abs(end - meta["duration_s"]) > tolerance_s:
            reasons.append(
                f"marker end {end:.2f}s is more than {tolerance_s}s from the "
                f"stimulus's own last sample ({meta['duration_s']:.2f}s)")
    if record["stages_ms"].get("speech_end_to_first_audio") is None:
        reasons.append("no first-audio timestamp")
    device_in = (record.get("device") or {}).get("input") or {}
    if device_in.get("exit") != 0 or not device_in.get("name"):
        reasons.append("input device not recorded")
    before = record.get("device") or {}
    after = record.get("device_after") or {}
    for direction in ("input", "output"):
        first = (before.get(direction) or {}).get("name")
        last = (after.get(direction) or {}).get("name")
        if first and last and first != last:
            reasons.append(f"{direction} device changed during the turn")
    before_levels = before.get("levels") or {}
    after_levels = after.get("levels") or {}
    for key in ("input_volume", "output_volume"):
        first = before_levels.get(key)
        last = after_levels.get(key)
        if first is not None and last is not None and first != last:
            reasons.append(f"{key} changed during the turn: {first} -> {last}")
    record["validity"] = {
        "ok": not reasons,
        "reasons": reasons,
        "exact": word_error_rate(record.get("stimulus", ""), transcript) == 0.0,
        "wer": word_error_rate(record.get("stimulus", ""), transcript),
    }
    record["speech_end"]["corrected_s"] = (
        round(end + (meta.get("marker_s") or 0.0), 3) if end is not None else None)
    total = record["stages_ms"].get("speech_end_to_first_audio")
    record["stages_ms"]["speech_end_to_first_audio_corrected"] = (
        round(total + (meta.get("marker_s") or 0.0) * 1000.0, 1)
        if total is not None else None)
    return record["validity"]


if __name__ == "__main__":
    print(json.dumps(snapshot(), indent=2))

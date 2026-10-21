#!/usr/bin/env python3
"""Level of a WAV file, in numbers a blocked microphone cannot fake.

A denied or muted capture is not an error: the recorder exits 0 and writes
digital silence. So the gate is RMS, not exit status. Stdlib only.

    rms.py FILE.wav    -> one JSON object on stdout, exit 1 when silent
"""
import array
import json
import math
import sys
import wave

# A quiet room sits near -70..-55 dBFS; 16-bit digital silence is -inf.
SILENCE_DBFS = -60.0


def analyze(path: str) -> dict:
    with wave.open(path, "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.getnframes()
        raw = w.readframes(frames)

    if width != 2:
        raise ValueError(f"expected 16-bit PCM, got {8 * width}-bit")

    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()

    count = len(samples)
    if count == 0:
        return {"path": path, "frames": 0, "duration_s": 0.0, "rms": 0.0,
                "rms_dbfs": None, "peak_dbfs": None, "silent": True}

    energy = sum(x * x for x in samples)
    rms = math.sqrt(energy / count) / 32768.0
    peak = max(abs(x) for x in samples) / 32768.0
    dbfs = 20.0 * math.log10(rms) if rms > 0 else None
    peak_dbfs = 20.0 * math.log10(peak) if peak > 0 else None

    return {
        "path": path,
        "frames": count,
        "channels": channels,
        "sample_rate": rate,
        "duration_s": round(count / channels / rate, 3),
        "rms": round(rms, 6),
        "rms_dbfs": round(dbfs, 2) if dbfs is not None else None,
        "peak_dbfs": round(peak_dbfs, 2) if peak_dbfs is not None else None,
        "silent": dbfs is None or dbfs < SILENCE_DBFS,
    }


def main(path: str) -> int:
    report = analyze(path)
    print(json.dumps(report))
    return 1 if report["silent"] else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: rms.py FILE.wav", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))

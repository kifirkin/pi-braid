#!/usr/bin/env python3
"""The v3 report: what the silence detector did, and what it cost.

`turn-v2.py` owns the turn and its four timestamps; this reads the turn
records it wrote and prints the three tables a detector measurement needs:
the mechanical clipping test, the end_reason distribution, and the device and
level block for every turn. The latency summary is `turn-v2.py report`'s own,
so the v3 numbers are computed by the same code that computed the control's.

    turn-v3.py report resident-window:out/v2-resident-window-*.json \
                      resident-vad:out/v2-resident-vad-*.json --primary resident-vad
    turn-v3.py report ... --markdown
"""
import glob
import importlib.util
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

_spec = importlib.util.spec_from_file_location("turn_v2", os.path.join(HERE, "turn-v2.py"))
t2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(t2)


def records(pattern: str) -> list[dict]:
    out = []
    for path in sorted(glob.glob(pattern)):
        with open(path) as f:
            out.append(json.load(f))
    return sorted(out, key=lambda r: r["run"])


def _median(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values), 1) if values else None


def report(specs: list[tuple[str, str]], primary: str | None) -> dict:
    base = t2.report([f"{label}:{pattern}" for label, pattern in specs], primary)
    base["clipping"] = {}
    base["vad"] = {}
    base["devices"] = {}
    for label, pattern in specs:
        recs = records(pattern)
        clip_rows, vad_rows, device_rows = [], [], []
        for r in recs:
            clip = r.get("clipping") or {}
            ep = r.get("endpointing") or {}
            device = r.get("device") or {}
            levels = device.get("levels") or {}
            delta = clip.get("capture_end_minus_marker_ms")
            clip_rows.append({
                "run": r["run"],
                "end_reason": ep.get("end_reason"),
                "capture_s": clip.get("capture_s"),
                "stimulus_end_in_capture_s": clip.get("speech_end_s"),
                "capture_end_minus_stimulus_end_ms": delta,
                "before_end_by_more_than_100ms": bool(delta is not None and delta < -100.0),
                "clipped": clip.get("clipped"),
            })
            vad_rows.append({
                "run": r["run"],
                "end_reason": ep.get("end_reason"),
                "vad_init": ep.get("vad_init"),
                "threshold": ep.get("vad_threshold"),
                "hangover_ms": ep.get("vad_hangover_ms"),
                "frames": ep.get("vad_frames"),
                "speech_frames": ep.get("vad_speech_frames"),
                "last_speech_end_s": ep.get("vad_last_speech_end_s"),
                "stop_audio_s": ep.get("vad_stop_audio_s"),
                "hangover_after_last_speech_ms": (
                    round((ep["vad_stop_audio_s"] - ep["vad_last_speech_end_s"]) * 1000.0, 1)
                    if ep.get("end_reason") == "vad"
                    and ep.get("vad_stop_audio_s") is not None
                    and ep.get("vad_last_speech_end_s") is not None
                    and ep["vad_last_speech_end_s"] >= 0 else None),
                "max_p": ep.get("vad_max_p"),
            })
            device_rows.append({
                "run": r["run"],
                "input": (device.get("input") or {}).get("name"),
                "input_transport": (device.get("input") or {}).get("transport"),
                "input_rate": (device.get("input") or {}).get("sample_rate"),
                "output": (device.get("output") or {}).get("name"),
                "output_transport": (device.get("output") or {}).get("transport"),
                "output_rate": (device.get("output") or {}).get("sample_rate"),
                "input_volume": levels.get("input_volume"),
                "output_volume": levels.get("output_volume"),
            })
        base["clipping"][label] = clip_rows
        base["vad"][label] = vad_rows
        base["devices"][label] = device_rows
        base.setdefault("medians", {})[label] = {
            "capture_end_minus_stimulus_end_ms": _median(
                [row["capture_end_minus_stimulus_end_ms"] for row in clip_rows]),
            "hangover_after_last_speech_ms": _median(
                [row["hangover_after_last_speech_ms"] for row in vad_rows]),
            "vad_frames": _median([row["frames"] for row in vad_rows]),
        }
    base["stimulus_sha256_by_arm"] = {
        label: sorted({r.get("stimulus_sha256") for r in records(pattern)} - {None})
        for label, pattern in specs
    }
    return base


def _table(headers: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join("---" for _ in headers) + "|"]
    for row in rows:
        out.append("| " + " | ".join("" if v is None else str(v) for v in row) + " |")
    return "\n".join(out)


def markdown(r: dict) -> str:
    parts = []
    parts.append("## Latency\n")
    rows = []
    for label, s in r["summary"].items():
        rows.append([label, s["turns"], s["turns_ok"], s["end_reasons"],
                     s["p50_ms"], s["p90_ms"], s["p50_corrected_ms"],
                     s["p90_corrected_ms"], s["stt_median_ms"],
                     s["first_synth_median_ms"], s["exact_transcripts"]])
    parts.append(_table(
        ["arm", "turns", "ok", "end_reason", "p50 raw", "p90 raw",
         "p50 corrected", "p90 corrected", "stt p50", "synth p50", "exact"],
        rows))
    parts.append("")
    for label, rows in r["clipping"].items():
        parts.append(f"## Clipping: {label}\n")
        before = sum(1 for row in rows if row["before_end_by_more_than_100ms"])
        parts.append(_table(
            ["run", "end_reason", "capture end s", "stimulus end in capture s",
             "capture end minus stimulus end ms", ">100 ms before end"],
            [[row["run"], row["end_reason"], row["capture_s"],
              row["stimulus_end_in_capture_s"],
              row["capture_end_minus_stimulus_end_ms"],
              "YES" if row["before_end_by_more_than_100ms"] else "no"]
             for row in rows]))
        parts.append(f"\nturns ending more than 100 ms before the stimulus end: "
                     f"{before}/{len(rows)}\n")
    for label, rows in r["vad"].items():
        if not any(row["frames"] is not None for row in rows):
            continue
        parts.append(f"## Detector: {label}\n")
        parts.append(_table(
            ["run", "end_reason", "init", "p>=0.5 frames", "speech frames",
             "last speech end s", "stop audio s", "hangover ms", "max p"],
            [[row["run"], row["end_reason"], row["vad_init"], row["frames"],
              row["speech_frames"], row["last_speech_end_s"], row["stop_audio_s"],
              row["hangover_after_last_speech_ms"], row["max_p"]] for row in rows]))
        parts.append("")
    for label, rows in r["devices"].items():
        parts.append(f"## Devices: {label}\n")
        parts.append(_table(
            ["run", "input", "transport", "rate", "output", "transport",
             "rate", "in vol", "out vol"],
            [[row["run"], row["input"], row["input_transport"], row["input_rate"],
              row["output"], row["output_transport"], row["output_rate"],
              row["input_volume"], row["output_volume"]] for row in rows]))
        parts.append("")
    if r.get("decision"):
        d = r["decision"]
        parts.append(f"## Decision\n\n{d['verdict']}: p50 {d['p50_ms']} ms "
                     f"marker-corrected against a {d['bar_ms']} ms bar.\n")
    return "\n".join(parts)


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] != "report":
        raise SystemExit(__doc__)
    rest = args[1:]
    primary = None
    if "--primary" in rest:
        i = rest.index("--primary")
        primary = rest[i + 1]
        del rest[i:i + 2]
    as_markdown = "--markdown" in rest
    rest = [a for a in rest if a != "--markdown"]
    specs = []
    for spec in rest:
        label, _, pattern = spec.partition(":")
        specs.append((label, pattern))
    result = report(specs, primary)
    print(markdown(result) if as_markdown else json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

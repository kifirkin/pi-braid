#!/usr/bin/env python3
"""Runs a command and reports what it cost: wall time and peak resident memory.

Memory is sampled from `ps -o rss= -p <pid>` while the child lives, and checked
against getrusage(RUSAGE_CHILDREN).ru_maxrss afterwards, because two instruments
that disagree are more informative than one clean number. ru_maxrss is a high
water mark over all reaped children, so use one measured child per process.

    measured.py -- CMD [ARGS...]
"""
import json
import resource
import subprocess
import sys
import time


def _rss_kb(pid: int) -> int:
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                         capture_output=True, text=True).stdout.strip()
    try:
        return int(out)
    except ValueError:
        return 0


def measure(cmd: list[str], sample_s: float = 0.05,
            stdin_text: str | None = None) -> dict:
    start = time.monotonic()
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE if stdin_text else None,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True)
    peak = 0
    while proc.poll() is None:
        peak = max(peak, _rss_kb(proc.pid))
        time.sleep(sample_s)
    stdout, stderr = proc.communicate(input=stdin_text)
    wall = time.monotonic() - start
    # ru_maxrss is a high-water mark over every child this process has reaped;
    # on macOS it is bytes. Absolute, not a delta: differencing two maxima is
    # not a measurement of one child.
    maxrss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    if sys.platform == "darwin":
        maxrss //= 1024

    return {
        "cmd": cmd,
        "exit": proc.returncode,
        "wall_s": round(wall, 4),
        "peak_rss_kb": peak,
        "rusage_max_child_kb": maxrss,
        "stdout": stdout,
        "stderr": stderr,
    }


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    result = measure(args)
    print(json.dumps(result))
    sys.exit(0 if result["exit"] == 0 else 1)

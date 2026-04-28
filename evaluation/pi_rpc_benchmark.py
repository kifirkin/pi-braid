#!/usr/bin/env python3
"""
pi RPC Mode Benchmark Harness
===========================
Runs pi agent in RPC mode and collects structured metrics.
Based on agent-testing skill patterns.
"""

import json
import os
import re
import select
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

# Default model
DEFAULT_MODEL = os.environ.get("PI_MODEL", "openrouter/qwen/qwen3.5-flash-02-23")
DEFAULT_EXTENSIONS = os.environ.get("PI_EXTENSIONS", "/Users/kifir/projects/agents/pi-braid")


@dataclass
class AgentResult:
    """Structured result from a pi agent run."""

    success: bool = False
    final_text: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    token_count: int = 0
    duration_seconds: float = 0.0
    error: Optional[str] = None
    extension_responses: int = 0
    turns: int = 0


def make_event(event_type: str, **kwargs) -> bytes:
    """Create a JSON event line."""
    event = {"type": event_type, **kwargs}
    return json.dumps(event).encode() + b"\n"


def extract_code(text: str, lang: str = "javascript") -> Optional[str]:
    """Extract code from markdown-fenced text."""
    if not text:
        return None
    pattern = rf"```(?:{lang}|{lang.replace('javascript','js')})\n(.*?)```"
    match = re.search(pattern, text, re.DOTALL)
    return match.group(1).strip() if match else None


class PiRPC:
    """Manages a pi RPC subprocess."""

    def __init__(
        self,
        extensions: Optional[str] = None,
        model: str = DEFAULT_MODEL,
        no_extensions: bool = False,
        tools: Optional[str] = None,
        provider: str = "openrouter",
    ):
        self.args = [
            "pi",
            "--mode", "rpc",
            "--no-session",
            "--provider", provider,
            "--model", model,
        ]
        if no_extensions:
            self.args.append("--no-extensions")
        elif extensions:
            self.args.extend(["-e", extensions])
        if tools:
            self.args.extend(["--tools", tools])

        self.proc: Optional[subprocess.Popen] = None

    def start(self, timeout: float = 10.0) -> None:
        """Start the pi subprocess."""
        self.proc = subprocess.Popen(
            self.args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ},
        )
        # Wait for startup
        time.sleep(timeout)

    def stop(self) -> None:
        """Kill and wait for the subprocess."""
        if self.proc:
            self.proc.poll()
            if self.proc.returncode is None:
                self.proc.kill()
            self.proc.wait()

    def send(self, event: bytes) -> None:
        """Send a JSON event to stdin."""
        if self.proc and self.proc.stdin:
            self.proc.stdin.write(event)
            self.proc.stdin.flush()

    def recv(self, timeout: float = 2.0) -> Optional[dict]:
        """Receive a JSON event from stdout."""
        if not self.proc:
            return None
        ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
        if not ready:
            return None
        line = self.proc.stdout.readline()
        if not line:
            return None
        return json.loads(line.decode().strip())


def run_task(
    prompt: str,
    extensions: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    no_extensions: bool = False,
    timeout: float = 90.0,
    cancel_extensions: bool = True,
) -> AgentResult:
    """
    Run a single task through pi RPC and collect metrics.

    Args:
        prompt: The task prompt
        extensions: Extension path (default: pi-braid)
        model: Model to use
        no_extensions: Use no extensions (baseline)
        timeout: Max seconds to wait
        cancel_extensions: Auto-cancel extension requests

    Returns:
        AgentResult with structured metrics
    """
    rpc = PiRPC(extensions=extensions if not no_extensions else None, model=model, no_extensions=no_extensions)
    result = AgentResult()

    try:
        rpc.start(timeout=2.0)
        start_time = time.time()

        # Send initial prompt
        rpc.send(make_event("prompt", message=prompt))

        last_message_end = None
        while time.time() - start_time < timeout:
            event = rpc.recv(timeout=3.0)
            if not event:
                if rpc.proc and rpc.proc.poll() is not None:
                    break
                continue

            etype = event.get("type", "")

            # Handle extension requests
            if etype == "extension_ui_request":
                result.extension_responses += 1
                if cancel_extensions:
                    rpc.send(make_event(
                        "extension_ui_response",
                        id=event.get("id"),
                        cancelled=True
                    ))

            # Track tool calls
            if etype in ("tool_execution_start", "tool_execution_end"):
                result.tool_calls.append({
                    "type": etype,
                    "tool": event.get("toolName", "unknown"),
                    "tool_call_id": event.get("toolCallId", ""),
                    "timestamp": time.time() - start_time,
                    "error": event.get("isError", False),
                })

            # Track message end (turn count)
            if etype == "message_end":
                last_message_end = event
                result.turns += 1
                # Extract text content
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "text":
                        result.final_text += block.get("text", "")

            # Agent done
            if etype == "agent_end":
                # Validate: response must not be a prompt echo and must have meaningful content
                stripped = result.final_text.strip()
                is_echo = (len(stripped) > 0 and stripped == prompt.strip())
                has_content = len(stripped) > 10
                result.success = not is_echo and has_content
                if is_echo:
                    result.error = "echo"
                elif not has_content:
                    result.error = "no_content"
                result.duration_seconds = time.time() - start_time
                result.token_count = len(result.final_text) // 4
                break

        result.duration_seconds = time.time() - start_time

        # If agent didn't end cleanly, check if it timed out
        if not result.success and result.duration_seconds >= timeout:
            result.error = "timeout"

    except Exception as e:
        result.error = str(e)
    finally:
        rpc.stop()

    return result


def run_comparison(
    prompt: str,
    baseline_extensions: Optional[str] = None,
    test_extensions: str = DEFAULT_EXTENSIONS,
    model: str = DEFAULT_MODEL,
    trials: int = 3,
    timeout: float = 90.0,
) -> dict:
    """
    Run comparison between baseline and test configuration.

    Returns:
        Summary dict with per-config metrics
    """
    results = {"baseline": [], "test": [], "model": model, "prompt_preview": prompt[:100]}

    for i in range(trials):
        print(f"[Trial {i+1}/{trials}] Running baseline...", file=sys.stderr)
        r = run_task(prompt, no_extensions=True, model=model, timeout=timeout)
        results["baseline"].append({
            "trial": i + 1,
            "success": r.success,
            "turns": r.turns,
            "token_count": r.token_count,
            "duration": r.duration_seconds,
            "tool_count": len(r.tool_calls),
            "extension_responses": r.extension_responses,
        })

        print(f"[Trial {i+1}/{trials}] Running test (pi-braid)...", file=sys.stderr)
        r = run_task(prompt, extensions=test_extensions, model=model, timeout=timeout)
        results["test"].append({
            "trial": i + 1,
            "success": r.success,
            "turns": r.turns,
            "token_count": r.token_count,
            "duration": r.duration_seconds,
            "tool_count": len(r.tool_calls),
            "extension_responses": r.extension_responses,
        })

    return results


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="pi RPC benchmark harness")
    parser.add_argument("--prompt", type=str, required=True, help="Task prompt")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="Model")
    parser.add_argument("--extensions", type=str, default=DEFAULT_EXTENSIONS, help="Extensions path")
    parser.add_argument("--no-extensions", action="store_true", help="No extensions baseline")
    parser.add_argument("--trials", type=int, default=3, help="Number of trials")
    parser.add_argument("--timeout", type=float, default=90.0, help="Timeout seconds")
    parser.add_argument("--output", type=str, help="Output JSON file")
    parser.add_argument("--compare", action="store_true", help="Run baseline comparison")
    args = parser.parse_args()

    if args.compare:
        results = run_comparison(
            args.prompt,
            test_extensions=args.extensions,
            model=args.model,
            trials=args.trials,
            timeout=args.timeout,
        )
    else:
        r = run_task(args.prompt, extensions=args.extensions if not args.no_extensions else None,
                      no_extensions=args.no_extensions, model=args.model, timeout=args.timeout)
        results = {
            "success": r.success,
            "turns": r.turns,
            "token_count": r.token_count,
            "duration": r.duration_seconds,
            "tool_count": len(r.tool_calls),
            "error": r.error,
            "final_text_preview": r.final_text[:500],
        }

    print(json.dumps(results, indent=2))
    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)
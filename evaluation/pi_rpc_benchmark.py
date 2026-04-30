#!/usr/bin/env python3
"""
pi RPC Benchmark — Uses threading to handle stdin/stdout simultaneously.
pi outputs events on stdout as they happen. If stdin blocks (waiting for extension responses),
pi deadlocks. Solution: dedicated stdout reader thread + queue.
"""
import json, os, select, subprocess, threading, time
from dataclasses import dataclass, field
from typing import Optional
from queue import Queue, Empty

DEFAULT_MODEL = os.environ.get("PI_MODEL", "minimax/MiniMax-M2.7")
DEFAULT_EXTENSIONS = os.environ.get("PI_EXTENSIONS", "/Users/kifir/projects/agents/pi-braid")


@dataclass
class AgentResult:
    """Structured result from a pi agent run."""
    success: bool = False
    final_text: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    extension_responses: int = 0
    turns: int = 0
    token_count: int = 0
    duration_seconds: float = 0.0
    error: Optional[str] = None


def make_event(event_type: str, **kwargs) -> bytes:
    """Create a JSON event line."""
    return json.dumps({"type": event_type, **kwargs}).encode() + b"\n"


class PiRPC:
    """Manages a pi RPC subprocess with thread-safe stdout reader."""

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
        self._evt_q: Optional[Queue] = None
        self._reader_thread: Optional[threading.Thread] = None

    def start(self, timeout: float = 10.0) -> None:
        """Start the pi subprocess and stdout reader thread."""
        self.proc = subprocess.Popen(
            self.args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ},
        )
        self._evt_q = Queue()
        self._reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader_thread.start()
        time.sleep(timeout)

    def _read_stdout(self) -> None:
        """Background thread: read stdout and queue events."""
        while True:
            try:
                ready, _, _ = select.select([self.proc.stdout], [], [], 0.5)
                if not ready:
                    if self.proc and self.proc.poll() is not None:
                        break
                    continue
                line = self.proc.stdout.readline()
                if not line:
                    break
                try:
                    evt = json.loads(line.decode().strip())
                    self._evt_q.put(evt)
                except json.JSONDecodeError:
                    continue
            except Exception:
                break
        self._evt_q.put(None)  # sentinel

    def send(self, event: bytes) -> None:
        """Send a JSON event to stdin."""
        if self.proc and self.proc.stdin:
            self.proc.stdin.write(event)
            self.proc.stdin.flush()

    def recv(self, timeout: float = 3.0) -> Optional[dict]:
        """Receive a queued JSON event from stdout."""
        try:
            evt = self._evt_q.get(timeout=timeout)
            return evt
        except Empty:
            return None

    def stop(self) -> None:
        """Kill and wait for the subprocess."""
        if self.proc:
            self.proc.poll()
            if self.proc.returncode is None:
                self.proc.kill()
            self.proc.wait()


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
    Threading ensures extension responses are sent without blocking stdout reader.
    """
    rpc = PiRPC(extensions=extensions if not no_extensions else None, model=model, no_extensions=no_extensions)
    result = AgentResult()

    try:
        rpc.start(timeout=2.0)
        rpc.send(make_event("prompt", message=prompt))

        start_time = time.time()
        while time.time() - start_time < timeout:
            event = rpc.recv(timeout=3.0)
            if event is None:
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
                continue

            # Track tool calls
            if etype in ("tool_execution_start", "tool_execution_end"):
                result.tool_calls.append({
                    "type": etype,
                    "tool": event.get("toolName", "unknown"),
                    "tool_call_id": event.get("toolCallId", ""),
                    "timestamp": time.time() - start_time,
                    "error": event.get("isError", False),
                })

            # Count assistant turns
            if etype == "message_start":
                if event.get("message", {}).get("role") == "assistant":
                    result.turns += 1

            # Accumulate text from assistant messages
            if etype in ("message_start", "message_end"):
                if event.get("message", {}).get("role") == "assistant":
                    for block in event.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            result.final_text += block.get("text", "")

            # Finalize on agent_end
            if etype == "agent_end":
                # agent_end.messages may have final complete text
                for msg in event.get("messages", []):
                    if msg.get("role") == "assistant":
                        for block in msg.get("content", []):
                            if block.get("type") == "text":
                                result.final_text += block.get("text", "")
                # Validate
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
        if not result.success and result.duration_seconds >= timeout:
            result.error = "timeout"

    finally:
        rpc.stop()

    return result

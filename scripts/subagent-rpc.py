#!/usr/bin/env python3
"""
pi-braid subagent RPC client.
Based on the proven pattern from pi_rpc_fixed.py.
"""
import subprocess
import json
import sys
import os
import select
import time
from pathlib import Path

PI_BRAID = "/Users/kifir/projects/agents/pi-braid"
PI_CMD = "pi"


class PiSubagent:
    def __init__(self, extensions=True, skills=None, model=None):
        self.proc = None
        self.model = model
        self.extensions = extensions
        self.skills = skills or []
        self._start()

    def _start(self):
        args = [PI_CMD, "--mode", "rpc", "--no-session"]
        if self.model:
            args += ["--model", self.model]
        if self.extensions:
            args += ["-e", str(Path(PI_BRAID).resolve())]
        for skill in self.skills:
            args += ["--skill", skill]

        print(f"Starting pi with pi-braid...", flush=True)
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ},
        )

    def send_task(self, task_prompt, timeout=300.0):
        """Execute a task. Returns (success, output)."""
        full_output = []

        cmd = json.dumps({"type": "prompt", "message": task_prompt}) + "\n"
        self.proc.stdin.write(cmd.encode())
        self.proc.stdin.flush()

        start = time.time()
        last_event_time = start
        agent_done = False
        last_text_time = start

        while time.time() - start < timeout:
            elapsed = time.time() - start
            ready, _, _ = select.select([self.proc.stdout], [], [], min(5.0, timeout - elapsed))

            if ready:
                line = self.proc.stdout.readline()
                if not line:
                    break
                last_event_time = time.time()

                try:
                    event = json.loads(line.decode().strip())
                except json.JSONDecodeError:
                    continue

                etype = event.get("type")

                # MUST respond to extension_ui_request or pi blocks
                if etype == "extension_ui_request":
                    resp = json.dumps({
                        "type": "extension_ui_response",
                        "id": event.get("id"),
                        "cancelled": True
                    }) + "\n"
                    self.proc.stdin.write(resp.encode())
                    self.proc.stdin.flush()
                    continue

                if etype == "agent_end":
                    agent_done = True
                    break

                elif etype == "message_update":
                    msg_evt = event.get("assistantMessageEvent", {})
                    evt_type = msg_evt.get("type", "")

                    if evt_type == "text_delta":
                        delta = msg_evt.get("delta", "")
                        full_output.append(delta)
                        last_text_time = time.time()

                    elif evt_type == "tool_result":
                        result = msg_evt.get("toolResultMessage", {})
                        tool_name = result.get("toolName", "?")
                        content = result.get("content", [])
                        if isinstance(content, list):
                            for c in content:
                                if c.get("type") == "text":
                                    full_output.append(f"\n[{tool_name}]\n{c.get('text', '')}\n")
                                    last_text_time = time.time()

                    elif evt_type == "tool_call":
                        tc = msg_evt.get("toolCallMessage", {})
                        full_output.append(f"\n[TOOL: {tc.get('name', '?')}()]\n")

            else:
                # No data ready — check for timeout
                if self.proc.poll() is not None:
                    break
                # Agent is quiet — if no text for 20s, consider done
                if time.time() - last_text_time > 20 and len(full_output) > 0:
                    break

        return agent_done, "".join(full_output)

    def close(self):
        if self.proc:
            try:
                self.proc.stdin.close()
            except:
                pass
            try:
                self.proc.wait(timeout=5)
            except:
                self.proc.kill()
            self.proc = None

    def __del__(self):
        self.close()


def main():
    if len(sys.argv) < 2:
        print("Usage: subagent-rpc.py <task_file.md> [model]", file=sys.stderr)
        sys.exit(1)

    task_file = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else None

    with open(task_file) as f:
        task_prompt = f.read()

    print(f"Task: {task_file}", flush=True)
    agent = PiSubagent(extensions=True, skills=[], model=model)
    success, output = agent.send_task(task_prompt, timeout=300.0)

    print(f"\n{'='*60}", flush=True)
    print(f"RESULT: {'SUCCESS' if success else 'INCOMPLETE'}", flush=True)
    print(f"{'='*60}\n", flush=True)

    print(output[:8000], flush=True)
    if len(output) > 8000:
        print(f"\n... [{len(output) - 8000} more chars]", flush=True)

    agent.close()
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()

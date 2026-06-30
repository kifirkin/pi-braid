#!/usr/bin/env python3
"""Minimal RPC client for spawning pi subagents.

Sends a prompt to pi in RPC mode, handles extension UI requests,
and prints the assistant's text response.

Usage:
    python3 subagent-rpc.py "Your task prompt here"
    python3 subagent-rpc.py task.md
    python3 subagent-rpc.py task.md --provider a0-venice --model deepseek-v4-flash
    python3 subagent-rpc.py task.md --no-extensions --provider openrouter --model "google/gemini-flash-latest"
    python3 subagent-rpc.py task.md --verbose  # show events on stderr
    python3 subagent-rpc.py task.md --timeout 300  # longer timeout

Environment:
    PI_CODING_AGENT_DIR — Override agent directory (for custom settings).
    OPENROUTER_API_KEY, A0_VENICE_API_KEY, etc. — must be set for providers.

Notes:
    - Uses a temp PI_CODING_AGENT_DIR with preprocessorEnabled=false to prevent
      the input-polisher extension from blocking prompts in RPC mode.
    - Extension UI requests (dialogs) are auto-cancelled.
    - Fire-and-forget UI requests (notify, setStatus, etc.) are ignored.
"""

import subprocess
import json
import sys
import os
import time
import select
import tempfile
import shutil
import atexit
import signal


# --- SIGINT forwarding ---

_current_subagent = None

def _forward_sigint(signum, frame):
    """Forward Ctrl+C to the subagent as an abort signal."""
    global _current_subagent
    if _current_subagent is not None:
        proc, verbose = _current_subagent
        if proc.poll() is None:
            if verbose:
                print("[subagent] User interrupt — sending abort...", file=sys.stderr)
            try:
                send_command(proc, {"type": "abort"})
            except:
                pass
            time.sleep(0.5)
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except:
                proc.kill()
    sys.exit(130)

signal.signal(signal.SIGINT, _forward_sigint)


# --- Temp settings dir management ---

_temp_dirs = set()

def _cleanup_temp_dirs():
    for d in _temp_dirs:
        shutil.rmtree(d, ignore_errors=True)

atexit.register(_cleanup_temp_dirs)

def create_temp_settings(base_settings_path=None, overrides=None):
    """Create a temp PI_CODING_AGENT_DIR with custom settings overrides.
    
    Key override: preprocessorEnabled=false (prevents input-polisher from
    blocking prompts in RPC mode by waiting for a second Enter press).
    """
    temp_dir = tempfile.mkdtemp(prefix="pi-subagent-")
    _temp_dirs.add(temp_dir)
    
    settings = {}
    if base_settings_path and os.path.isfile(base_settings_path):
        with open(base_settings_path) as f:
            settings = json.load(f)
    
    # Always disable preprocessor for subagents
    settings["preprocessorEnabled"] = False
    
    if overrides:
        settings.update(overrides)
    
    with open(os.path.join(temp_dir, "settings.json"), "w") as f:
        json.dump(settings, f, indent=2)
    
    return temp_dir


# --- RPC client ---

def send_command(proc, cmd):
    """Send a JSON command to pi's stdin."""
    line = json.dumps(cmd) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()


def handle_extension_ui(proc, event):
    """Handle extension UI requests.
    
    Dialog methods (select, confirm, input, editor) → cancel them.
    Fire-and-forget methods (notify, setStatus, setWidget, etc.) → ignore.
    """
    dialog_methods = {"select", "confirm", "input", "editor"}
    method = event.get("method", "")
    if method in dialog_methods:
        send_command(proc, {
            "type": "extension_ui_response",
            "id": event.get("id"),
            "cancelled": True
        })


def run_subagent(prompt_text, provider=None, model=None, extensions=True,
                 tools=None, timeout=120, env_overrides=None, verbose=False):
    """Run a pi subagent in RPC mode and return the assistant's text response.
    
    Args:
        prompt_text: The task prompt string.
        provider: LLM provider name (e.g. "a0-venice", "openrouter").
        model: Model name/pattern (e.g. "deepseek-v4-flash").
        extensions: If True, load pi-braid extensions. If False, use --no-extensions.
        tools: Comma-separated tool list (only with --no-extensions).
        timeout: Max seconds to wait for completion.
        env_overrides: Dict of extra environment variables.
        verbose: If True, print progress and events to stderr as they arrive.
    
    Returns:
        The assistant's text response (str). Always returns a string; empty
        on timeout or error.
    """
    # Always use temp settings to disable input-polisher
    base_settings = os.path.expanduser("~/.pi/agent/settings.json")
    temp_pi_dir = create_temp_settings(base_settings)
    
    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = temp_pi_dir
    if env_overrides:
        env.update(env_overrides)
    
    cmd = ["pi", "--mode", "rpc", "--no-session"]
    
    if extensions:
        # Resolve braid root relative to this script's location
        script_dir = os.path.dirname(os.path.abspath(__file__))
        braid_root = os.environ.get("BRAID_ROOT",
            os.path.dirname(script_dir))
        cmd.extend(["-e", braid_root])
    else:
        cmd.append("--no-extensions")
    
    if tools:
        cmd.extend(["--tools", tools])
    
    if provider:
        cmd.extend(["--provider", provider])
    if model:
        cmd.extend(["--model", model])
    
    if verbose:
        print(f"[subagent] Cmd: {' '.join(cmd)}", file=sys.stderr)
        print(f"[subagent] Env: PI_CODING_AGENT_DIR={temp_pi_dir}", file=sys.stderr)
    
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE if not verbose else None,
        text=True,
        bufsize=1,
        env=env
    )
    
    # Register for SIGINT forwarding
    global _current_subagent
    _current_subagent = (proc, verbose)
    
    # Send the prompt
    if verbose:
        print(f"[subagent] Sending prompt ({len(prompt_text)} chars)...", file=sys.stderr)
    send_command(proc, {"type": "prompt", "message": prompt_text})
    
    # Read events
    full_text = ""
    started = time.time()
    
    while True:
        if time.time() - started > timeout:
            if verbose:
                print(f"[subagent] Timeout ({timeout}s) — sending abort...", file=sys.stderr)
            send_command(proc, {"type": "abort"})
            time.sleep(1)
            proc.kill()
            break
        
        if proc.poll() is not None:
            break
        
        ready, _, _ = select.select([proc.stdout], [], [], 1.0)
        if not ready:
            continue
        
        line = proc.stdout.readline()
        if not line:
            break
        
        line = line.strip()
        if not line:
            continue
        
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        
        event_type = event.get("type", "")
        
        if event_type == "extension_ui_request":
            if verbose:
                print(f"[subagent] UI request: {event.get('method', '?')} "
                      f"({event.get('methodMeta', {}).get('title', 'no title')})",
                      file=sys.stderr)
            handle_extension_ui(proc, event)
            continue
        
        if event_type == "message_update":
            delta = event.get("assistantMessageEvent", {})
            if delta.get("type") == "text_delta":
                chunk = delta.get("delta", "")
                full_text += chunk
                if verbose:
                    print(chunk, end="", file=sys.stderr, flush=True)
            elif verbose:
                print(f"[subagent] message_update: {delta.get('type', '?')}",
                      file=sys.stderr)
        
        if event_type == "agent_end":
            break
    
    # Fallback: try get_last_assistant_text if we captured nothing
    if not full_text and proc.poll() is None:
        send_command(proc, {"type": "get_last_assistant_text"})
        time.sleep(0.5)
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        if ready:
            line = proc.stdout.readline()
            if line:
                try:
                    resp = json.loads(line.strip())
                    if resp.get("success"):
                        full_text = resp.get("data", {}).get("text", "")
                except:
                    pass
    
    # Clean up
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except:
        proc.kill()
    
    return full_text


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Spawn a pi subagent via RPC mode"
    )
    parser.add_argument("prompt", help="Task prompt (string or path to .md file)")
    parser.add_argument("--provider", default=None,
                        help="LLM provider (e.g. a0-venice, openrouter)")
    parser.add_argument("--model", default=None,
                        help="Model name/pattern (e.g. deepseek-v4-flash)")
    parser.add_argument("--no-extensions", action="store_true",
                        help="Disable pi-braid extensions (use built-in providers only)")
    parser.add_argument("--tools", default=None,
                        help="Comma-separated tool list (with --no-extensions)")
    parser.add_argument("--timeout", type=int, default=120,
                        help="Timeout in seconds (default: 120)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show progress and events on stderr")
    args = parser.parse_args()
    
    # If prompt is a file path, read it
    if os.path.isfile(args.prompt):
        with open(args.prompt) as f:
            prompt_text = f.read()
    else:
        prompt_text = args.prompt
    
    result = run_subagent(
        prompt_text,
        provider=args.provider,
        model=args.model,
        extensions=not args.no_extensions,
        tools=args.tools,
        timeout=args.timeout,
        verbose=args.verbose
    )
    
    print(result)


if __name__ == "__main__":
    main()

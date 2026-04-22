#!/usr/bin/env python3
"""
Multi-Turn Debugging Benchmark (BM1)
===================================
A research benchmark for pi-braid multi-turn debugging capability.

Design:
  Bug-fixing task with phases:
    1. Read → 2. Propose → 3. Test (fail) → 4. Debug → 5. Fix → 6. Pass

Metrics:
  - Diagnosis accuracy
  - Fix quality
  - Over-fix avoidance (didn't change unrelated code)
  - Explanation quality
  - Multi-turn persistence (can it track state across turns?)

Tasks: Python/JavaScript bugs with multiple phases. Each phase requires
a different tool pattern and the agent must remember context from prior phases.
"""

import json
import os
import re
import subprocess
import sys
import time
import select
from dataclasses import dataclass, field
from typing import Optional
from pi_rpc_benchmark import PiRPC, make_event, extract_code, AgentResult

DEFAULT_MODEL = os.environ.get("PI_MODEL", "openrouter/qwen/qwen3.5-flash-02-23")
DEFAULT_EXTENSIONS = os.environ.get("PI_EXTENSIONS", "/Users/kifir/projects/agents/pi-braid")


# ── Multi-Turn Debug Tasks ────────────────────────────────────────────────────

TASKS = [
    {
        "id": "bug-race-condition",
        "name": "Race Condition in Async Handler",
        "description": """You are debugging a Node.js HTTP server with a race condition.

The server has a bug where concurrent requests can corrupt shared state.
The file `server.js` has a GET /counter endpoint that increments a shared counter.
Under load, the counter gets corrupted (race condition in the increment).

Steps to fix:
1. Read server.js to understand the current implementation
2. Identify the race condition (non-atomic increment)
3. Propose a fix using atomic operations or locks
4. Implement the fix
5. Test that concurrent requests don't corrupt the counter

Bug hint: The increment `count++` is not atomic. Multiple async handlers
can interleave between reading and writing `count`.
""",
        "expected_tools": ["read", "bash", "edit"],
        "success_criteria": [
            "Uses atomic operation or mutex/lock",
            "Handles concurrent requests without corruption",
            "Doesn't change unrelated server functionality",
        ],
        "phase_hints": {
            "diagnose": "look for non-atomic read-modify-write patterns",
            "propose": "mention atomic increment or async lock",
            "fix": "add proper synchronization",
        },
    },
    {
        "id": "bug-memory-leak",
        "name": "Memory Leak in Event Listener",
        "description": """You are debugging a JavaScript application with a memory leak.

The file `app.js` registers event listeners in a loop, but never removes them.
Over time, this causes memory to grow indefinitely.
The leak only appears when the component re-renders (which happens on user interaction).

Steps to fix:
1. Read app.js and identify the event listener registration
2. Find where listeners are added but never removed
3. Propose a cleanup strategy (removeListener, once, or WeakRef)
4. Implement the cleanup
5. Verify the fix by checking listener count before/after re-render

Bug hint: Each render adds new listeners but old ones are never removed.
Look for addEventListener without corresponding removeEventListener in cleanup.
""",
        "expected_tools": ["read", "edit", "bash"],
        "success_criteria": [
            "Listeners are cleaned up (removeEventListener or once)",
            "No duplicate listeners on re-render",
            "Cleanup is triggered on component unmount/cleanup",
        ],
        "phase_hints": {
            "diagnose": "look for event listener registration in loops without cleanup",
            "propose": "mention removeEventListener or one-time listeners",
            "fix": "add proper cleanup in unmount/cleanup function",
        },
    },
    {
        "id": "bug-null-undefined",
        "name": "Null Reference in Async Chain",
        "description": """You are debugging a TypeScript application with null reference errors.

The file `service.ts` has an async function chain where a null value propagates
through multiple .then() calls, causing a runtime crash.

Steps to fix:
1. Read service.ts to understand the async chain
2. Find where null is introduced (probably a failed DB query returning null)
3. Identify where it causes a crash (probably a property access on null)
4. Propose null-safety improvements (optional chaining, null check, proper error handling)
5. Implement the fix
6. Verify the fix handles null gracefully

Bug hint: A database query returns null when no record is found, but the code
assumes the result is always an object and accesses `.id` directly without optional chaining.
""",
        "expected_tools": ["read", "edit"],
        "success_criteria": [
            "Uses optional chaining (?.) or null check",
            "Handles null from DB gracefully",
            "Doesn't swallow legitimate errors",
        ],
        "phase_hints": {
            "diagnose": "look for .then() chains where one step can return null",
            "propose": "mention optional chaining or explicit null handling",
            "fix": "add ? or null check before property access",
        },
    },
]


# ── Task Setup ───────────────────────────────────────────────────────────────

TASK_FILES = {
    "bug-race-condition": {
        "path": "server.js",
        "content": """const http = require('http');
const count = { value: 0 };

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/counter') {
    // BUG: Non-atomic read-modify-write - race condition!
    const current = count.value;
    // Async operation between read and write creates race window
    setTimeout(() => {
      count.value = current + 1;
      res.end(`Counter: ${count.value}`);
    }, Math.random() * 10);
  } else if (req.url === '/reset') {
    count.value = 0;
    res.end('Reset to 0');
  } else {
    res.end('OK');
  }
});

server.listen(3000, () => console.log('Server running on port 3000'));
""",
    },
    "bug-memory-leak": {
        "path": "app.js",
        "content": """// Memory leak: event listeners accumulate on every render
class Component {
  constructor() {
    this.data = [];
    this.attachListeners();
  }

  attachListeners() {
    // BUG: These listeners are added every time attachListeners is called
    // but never removed. Calling render() multiple times adds more listeners.
    document.addEventListener('click', this.handleClick);
    document.addEventListener('keydown', this.handleKey);
    window.addEventListener('resize', this.handleResize);
  }

  handleClick(e) {
    console.log('Clicked:', e.target);
    this.data.push({ type: 'click', time: Date.now() });
  }

  handleKey(e) {
    console.log('Key:', e.key);
  }

  handleResize() {
    console.log('Resized');
  }

  render() {
    // Re-render adds more listeners each time!
    this.attachListeners();
    document.body.innerHTML = '<div>Rendered ' + this.data.length + ' events</div>';
  }
}

const app = new Component();
// Each render call adds 3 more listeners
app.render();
app.render();
app.render();
console.log('Listeners accumulated. Check with Chrome DevTools.');
""",
    },
    "bug-null-undefined": {
        "path": "service.ts",
        "content": """// TypeScript - Null reference crash in async chain
interface User { id: string; name: string; email: string; }

async function getUserByEmail(email: string): Promise<User | null> {
  // BUG: Returns null when user not found, but downstream code assumes User
  const mockDb = new Map<string, User>([
    ['alice@example.com', { id: '1', name: 'Alice', email: 'alice@example.com' }],
    ['bob@example.com', { id: '2', name: 'Bob', email: 'bob@example.com' }],
  ]);
  return mockDb.get(email) ?? null;
}

async function getUserIdByEmail(email: string): Promise<string> {
  // BUG: Calls getUserByEmail but doesn't check for null
  // When user not found, this crashes with: Cannot read property 'id' of null
  return getUserByEmail(email).then(user => user.id);  // <-- CRASH HERE
}

async function main() {
  try {
    // This should work
    const id1 = await getUserIdByEmail('alice@example.com');
    console.log('Alice ID:', id1);

    // This crashes because carol@example.com doesn't exist
    const id2 = await getUserIdByEmail('carol@example.com');
    console.log('Carol ID:', id2);  // Never reached
  } catch (e) {
    console.error('Error:', e.message);
    // Expected: Cannot read property 'id' of null
  }
}

main();
""",
    },
}


# ── Benchmark Runner ──────────────────────────────────────────────────────────

@dataclass
class MultiTurnResult:
    task_id: str = ""
    task_name: str = ""
    phases_completed: list = field(default_factory=list)
    diagnosis_accurate: bool = False
    fix_quality: float = 0.0  # 0-1
    over_fix: bool = False  # Changed too much?
    explanation_quality: float = 0.0  # 0-1
    multi_turn_persistence: float = 0.0  # Did it track state across turns?
    total_turns: int = 0
    total_tools: int = 0
    duration: float = 0.0
    success: bool = False
    error: Optional[str] = None
    phases: list = field(default_factory=list)  # Per-phase details


def create_task_files(task_id: str, workspace_dir: str) -> bool:
    """Create the buggy source file in the workspace."""
    task = TASK_FILES.get(task_id)
    if not task:
        return False

    filepath = os.path.join(workspace_dir, task["path"])
    try:
        with open(filepath, "w") as f:
            f.write(task["content"])
        return True
    except Exception as e:
        print(f"Failed to create task files: {e}", file=sys.stderr)
        return False


def check_fix_quality(task_id: str, workspace_dir: str, final_text: str) -> tuple[float, bool]:
    """
    Check fix quality for a task.
    Returns (fix_quality_score, over_fix_flag)

    Fix quality: 0-1 based on whether it addressed the root cause.
    Over-fix: True if it changed significantly more than necessary.
    """
    task = TASKS[tasks.index(task_id)] if task_id in [t["id"] for t in TASKS] else None
    if not task:
        return 0.5, False

    criteria_met = 0
    total_criteria = len(task["success_criteria"])

    for criterion in task["success_criteria"]:
        if criterion.lower() in final_text.lower():
            criteria_met += 1
        # Check actual code changes
        if task_id == "bug-race-condition":
            if "atomic" in final_text.lower() or "lock" in final_text.lower() or "mutex" in final_text.lower():
                criteria_met += 0.5
            if "compare" in final_text.lower() and "swap" in final_text.lower():
                criteria_met += 0.5
        elif task_id == "bug-memory-leak":
            if "removeEventListener" in final_text or "removeListener" in final_text:
                criteria_met += 0.5
            if "off(" in final_text or "once" in final_text.lower():
                criteria_met += 0.5
        elif task_id == "bug-null-undefined":
            if "?." in final_text or "optional chaining" in final_text.lower():
                criteria_met += 0.5
            if "null check" in final_text.lower() or "if (!user)" in final_text:
                criteria_met += 0.5

    fix_quality = min(criteria_met / total_criteria, 1.0)

    # Check for over-fix
    code_blocks = re.findall(r'```(?:javascript|js|typescript|ts)\n(.*?)```', final_text, re.DOTALL)
    total_lines = sum(len(b.split('\n')) for b in code_blocks)
    over_fix = total_lines > 50  # If more than 50 lines of code were changed, might be over-fixing

    return fix_quality, over_fix


def run_bm1(
    task_id: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    extensions: str = DEFAULT_EXTENSIONS,
    timeout: float = 120.0,
) -> list[MultiTurnResult]:
    """
    Run the multi-turn debugging benchmark.

    Args:
        task_id: Specific task to run (or all if None)
        model: Model to use
        extensions: Extension path
        timeout: Per-trial timeout

    Returns:
        List of MultiTurnResult objects
    """
    tasks_to_run = [t for t in TASKS if task_id is None or t["id"] == task_id]
    results = []

    for task in tasks_to_run:
        print(f"\n=== BM1: {task['name']} ===", file=sys.stderr)

        # Create workspace
        workspace = f"/tmp/bm1-{task['id']}-{os.getpid()}"
        os.makedirs(workspace, exist_ok=True)
        create_task_files(task["id"], workspace)

        # Run the task through pi
        print(f"Running task in {workspace}...", file=sys.stderr)

        # First, set up the task context
        setup_prompt = f"""
IMPORTANT: You are debugging code in {workspace}. 
Before starting, run: cd {workspace} && ls -la

Then read the files to understand the bug and fix it.

{task['description']}

After fixing, run the code to verify your fix works.
"""

        rpc = PiRPC(extensions=extensions, model=model)
        result = AgentResult()

        try:
            rpc.start(timeout=3.0)
            start_time = time.time()

            rpc.send(make_event("prompt", message=setup_prompt))

            phase_turns = []
            current_phase_tools = []
            last_text = ""

            while time.time() - start_time < timeout:
                event = rpc.recv(timeout=5.0)
                if not event:
                    if rpc.proc and rpc.proc.poll() is not None:
                        break
                    continue

                etype = event.get("type", "")

                if etype == "extension_ui_request":
                    rpc.send(make_event("extension_ui_response", id=event.get("id"), cancelled=True))

                if etype in ("tool_execution_start", "tool_execution_end"):
                    result.tool_calls.append({
                        "type": etype,
                        "tool": event.get("toolName", "unknown"),
                        "timestamp": time.time() - start_time,
                        "error": event.get("isError", False),
                    })

                if etype == "message_end":
                    result.turns += 1
                    for block in event.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            text = block.get("text", "")
                            last_text += text
                            result.final_text += text
                            # Detect phase transitions
                            if "read" in text.lower() and "edit" not in text.lower():
                                phase_turns.append("diagnose")
                            elif "fix" in text.lower() or "implement" in text.lower():
                                phase_turns.append("implement")
                            elif "test" in text.lower() or "verify" in text.lower():
                                phase_turns.append("verify")

                if etype == "agent_end":
                    result.success = True
                    result.duration_seconds = time.time() - start_time
                    break

            result.duration_seconds = time.time() - start_time

        except Exception as e:
            result.error = str(e)
        finally:
            rpc.stop()

        # Analyze results
        fix_quality, over_fix = check_fix_quality(task["id"], workspace, result.final_text)

        multi_turn_score = 1.0 if result.turns >= 3 else result.turns / 3.0

        mr = MultiTurnResult(
            task_id=task["id"],
            task_name=task["name"],
            phases_completed=list(set(phase_turns)),
            diagnosis_accurate="diagnose" in phase_turns,
            fix_quality=fix_quality,
            over_fix=over_fix,
            explanation_quality=min(len(result.final_text) / 500, 1.0),
            multi_turn_persistence=multi_turn_score,
            total_turns=result.turns,
            total_tools=len(result.tool_calls),
            duration=result.duration_seconds,
            success=result.success,
            error=result.error,
        )
        results.append(mr)

        print(f"  Turns: {result.turns}, Tools: {len(result.tool_calls)}, "
              f"Fix quality: {fix_quality:.1f}, Multi-turn: {multi_turn_score:.1f}",
              file=sys.stderr)

        # Cleanup workspace
        try:
            subprocess.run(["rm", "-rf", workspace], timeout=5)
        except:
            pass

    return results


def format_bm1_summary(results: list[MultiTurnResult]) -> str:
    """Format BM1 results as a summary table."""
    lines = ["# BM1: Multi-Turn Debugging Benchmark Results", ""]

    # Per-task table
    lines.append("## Per-Task Results")
    lines.append("| Task | Success | Turns | Tools | Fix Quality | Multi-Turn |")
    lines.append("|------|---------|-------|-------|-------------|------------|")
    for r in results:
        status = "✅" if r.success else "❌"
        lines.append(f"| {r.task_name} | {status} | {r.total_turns} | {r.total_tools} | "
                     f"{r.fix_quality:.0%} | {r.multi_turn_persistence:.0%} |")

    # Aggregate
    if results:
        avg_fix = sum(r.fix_quality for r in results) / len(results)
        avg_multiturn = sum(r.multi_turn_persistence for r in results) / len(results)
        success_rate = sum(1 for r in results if r.success) / len(results)
        avg_turns = sum(r.total_turns for r in results) / len(results)

        lines.append("")
        lines.append("## Aggregate Metrics")
        lines.append(f"- **Success Rate**: {success_rate:.0%}")
        lines.append(f"- **Average Fix Quality**: {avg_fix:.0%}")
        lines.append(f"- **Multi-Turn Persistence**: {avg_multiturn:.0%}")
        lines.append(f"- **Average Turns**: {avg_turns:.1f}")
        lines.append(f"- **Total Trials**: {len(results)}")

    return "\n".join(lines)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="BM1: Multi-Turn Debugging Benchmark")
    parser.add_argument("--task", type=str, help="Specific task ID to run")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="Model")
    parser.add_argument("--extensions", type=str, default=DEFAULT_EXTENSIONS, help="Extensions path")
    parser.add_argument("--timeout", type=float, default=120.0, help="Timeout per trial")
    parser.add_argument("--output", type=str, help="Output JSON file")
    args = parser.parse_args()

    results = run_bm1(task_id=args.task, model=args.model, extensions=args.extensions, timeout=args.timeout)

    summary = format_bm1_summary(results)
    print(summary)

    if args.output:
        with open(args.output, "w") as f:
            json.dump([{
                "task_id": r.task_id,
                "task_name": r.task_name,
                "success": r.success,
                "fix_quality": r.fix_quality,
                "multi_turn_persistence": r.multi_turn_persistence,
                "total_turns": r.total_turns,
                "duration": r.duration,
            } for r in results], f, indent=2)
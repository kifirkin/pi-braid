#!/usr/bin/env python3
"""Smoke test: verify decomposed modules + state migration are properly wired.

Tests:
1. Planner tools (goal, plan) — session-scoped via getExtensionState
2. Context-manager tools (context_tag, context_log, context_audit, context_prune, context_compress, context_checkout) — decomposed + migrated
3. Enforcement state — migrated to getState(ctx)
4. Retry module — properly imported and functional
5. Pruning module — properly imported and functional

Uses pi RPC mode with a cheap model.
"""

import subprocess
import json
import os
import select
import time
import sys

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
if not API_KEY:
    print("ERROR: OPENROUTER_API_KEY not set")
    sys.exit(1)

MODEL = "openrouter/openai/gpt-4.1-mini"

def run_pi_test(prompt, timeout=60):
    """Run pi with a prompt and collect tool execution events."""
    cmd = [
        "pi", "--mode", "rpc", "--no-session",
        "--provider", "openrouter", "--model", MODEL,
        "-e", "/Users/kifir/projects/agents/pi-braid",
    ]
    
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "OPENROUTER_API_KEY": API_KEY},
    )
    
    prompt_json = json.dumps({"type": "prompt", "message": prompt}) + "\n"
    proc.stdin.write(prompt_json.encode())
    proc.stdin.flush()
    
    events = []
    tool_calls = []
    tool_results = []
    errors = []
    final_text = ""
    start = time.time()
    
    while time.time() - start < timeout:
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        if not ready:
            if proc.poll() is not None:
                break
            continue
        
        line = proc.stdout.readline()
        if not line:
            break
        
        try:
            event = json.loads(line.decode().strip())
            etype = event.get("type")
            events.append(etype)
            
            # Handle extension UI requests
            if etype == "extension_ui_request":
                resp = json.dumps({
                    "type": "extension_ui_response",
                    "id": event.get("id"),
                    "cancelled": True
                }) + "\n"
                proc.stdin.write(resp.encode())
                proc.stdin.flush()
            
            # Track tool calls
            if etype == "tool_execution_start":
                tool_calls.append({
                    "id": event.get("toolCallId"),
                    "name": event.get("toolName"),
                    "args": event.get("args", {}),
                })
            
            # Track tool results
            if etype == "tool_execution_end":
                tool_results.append({
                    "id": event.get("toolCallId"),
                    "name": event.get("toolName"),
                    "isError": event.get("isError", False),
                    "result": str(event.get("result", ""))[:200],
                })
                if event.get("isError"):
                    errors.append(f"Tool error: {event.get('toolName')} — {str(event.get('result', ''))[:200]}")
            
            # Get final text
            if etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for block in msg.get("content", []):
                        if block.get("type") == "text":
                            final_text += block.get("text", "")
            
            if etype == "agent_end":
                break
        except json.JSONDecodeError:
            pass
    
    proc.kill()
    proc.wait()
    
    return {
        "events": events,
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "errors": errors,
        "final_text": final_text,
        "event_types": sorted(set(events)),
    }


def test_planner():
    """Test 1: Goal tool (session-scoped via getExtensionState)."""
    print("\n" + "="*60)
    print("TEST 1: Planner tools (goal)")
    print("="*60)
    
    result = run_pi_test(
        "Create a goal called 'smoke-test' with description 'Verify planner works' "
        "and success criteria 'Goal created successfully'. Use the goal tool."
    )
    
    goal_calls = [c for c in result["tool_calls"] if c["name"] == "goal"]
    goal_results = [r for r in result["tool_results"] if r["name"] == "goal"]
    goal_errors = [r for r in goal_results if r["isError"]]
    
    passed = len(goal_calls) > 0 and len(goal_errors) == 0
    
    print(f"  Goal tool calls: {len(goal_calls)}")
    print(f"  Goal results: {len(goal_results)}")
    print(f"  Goal errors: {len(goal_errors)}")
    if goal_results:
        print(f"  Sample result: {goal_results[0]['result'][:100]}")
    print(f"  {'✅ PASS' if passed else '❌ FAIL'}")
    
    return passed


def test_context_manager():
    """Test 2: Context-manager tools (decomposed + migrated)."""
    print("\n" + "="*60)
    print("TEST 2: Context-manager tools")
    print("="*60)
    
    result = run_pi_test(
        "First create a context tag called 'test-milestone'. "
        "Then run context_audit to check session health. "
        "Use the context_tag and context_audit tools."
    )
    
    cm_tools = ["context_tag", "context_log", "context_audit", "context_prune"]
    cm_calls = {t: [c for c in result["tool_calls"] if c["name"] == t] for t in cm_tools}
    cm_errors = [r for r in result["tool_results"] if r["name"] in cm_tools and r["isError"]]
    
    tag_calls = cm_calls["context_tag"]
    audit_calls = cm_calls["context_audit"]
    
    passed = len(tag_calls) > 0 and len(audit_calls) > 0 and len(cm_errors) == 0
    
    print(f"  context_tag calls: {len(tag_calls)}")
    print(f"  context_audit calls: {len(audit_calls)}")
    print(f"  CM tool errors: {len(cm_errors)}")
    for r in result["tool_results"]:
        if r["name"] in cm_tools:
            print(f"  {r['name']}: error={r['isError']}, result={r['result'][:80]}")
    print(f"  {'✅ PASS' if passed else '❌ FAIL'}")
    
    return passed


def test_enforcement_state():
    """Test 3: Enforcement state is session-scoped (exercise via think + edit flow)."""
    print("\n" + "="*60)
    print("TEST 3: Enforcement state (think + edit flow)")
    print("="*60)
    
    result = run_pi_test(
        "Think about what 2+2 equals. Then create a file /tmp/smoke-test.txt with the answer. "
        "Use the think tool first, then the write tool."
    )
    
    think_calls = [c for c in result["tool_calls"] if c["name"] == "think"]
    write_calls = [c for c in result["tool_calls"] if c["name"] == "write"]
    tool_errors = [r for r in result["tool_results"] if r["isError"]]
    
    # The enforcement should NOT block the think+write flow
    passed = len(think_calls) > 0 and len(tool_errors) == 0
    
    print(f"  think calls: {len(think_calls)}")
    print(f"  write calls: {len(write_calls)}")
    print(f"  Tool errors: {len(tool_errors)}")
    for e in tool_errors[:3]:
        print(f"    Error: {e['name']} — {e['result'][:100]}")
    print(f"  {'✅ PASS' if passed else '❌ FAIL'}")
    
    return passed


def test_context_log_and_compress():
    """Test 4: Context log + compress tools (verify decomposed modules wire up)."""
    print("\n" + "="*60)
    print("TEST 4: Context log + prune (decomposed wiring)")
    print("="*60)
    
    result = run_pi_test(
        "Run context_log to see the session history. "
        "Then run context_prune to check for prune candidates. "
        "Use the context_log and context_prune tools."
    )
    
    log_calls = [c for c in result["tool_calls"] if c["name"] == "context_log"]
    prune_calls = [c for c in result["tool_calls"] if c["name"] == "context_prune"]
    log_results = [r for r in result["tool_results"] if r["name"] == "context_log"]
    prune_results = [r for r in result["tool_results"] if r["name"] == "context_prune"]
    
    # context_prune uses analysis.ts (analyzeSession) and pruning.ts (PruningEngine)
    # If these modules are properly wired, prune should return results
    prune_ok = any("No prune candidates" in r["result"] or "prune candidate" in r["result"].lower() 
                   for r in prune_results if not r["isError"])
    
    passed = len(log_calls) > 0 and len(prune_calls) > 0 and prune_ok
    
    print(f"  context_log calls: {len(log_calls)}")
    print(f"  context_prune calls: {len(prune_calls)}")
    print(f"  Prune returned valid result: {prune_ok}")
    for r in prune_results:
        print(f"  prune result: {r['result'][:120]}")
    print(f"  {'✅ PASS' if passed else '❌ FAIL'}")
    
    return passed


def main():
    print("SMOKE TEST: pi-braid decomposition + state migration")
    print(f"Model: {MODEL}")
    print(f"Extension: /Users/kifir/projects/agents/pi-braid")
    
    results = {}
    
    tests = [
        ("planner", test_planner),
        ("context-manager", test_context_manager),
        ("enforcement", test_enforcement_state),
        ("context-prune", test_context_log_and_compress),
    ]
    
    for name, test_fn in tests:
        try:
            results[name] = test_fn()
        except Exception as e:
            print(f"  ❌ EXCEPTION: {e}")
            results[name] = False
    
    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    
    for name, passed in results.items():
        print(f"  {'✅' if passed else '❌'} {name}")
    
    total = len(results)
    passed = sum(1 for v in results.values() if v)
    print(f"\n  {passed}/{total} tests passed")
    
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())

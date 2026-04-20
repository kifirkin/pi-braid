#!/usr/bin/env python3
"""Smoke test for Phase 2+3: heartbeat, memory stores, conflict QA, evidence integration."""
import subprocess
import json
import os
import select
import time
import sys

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")

# Use a0venice provider (free tier works for tool use)
PROVIDER = os.environ.get("PI_PROVIDER", "a0-venice")
MODEL = os.environ.get("PI_MODEL", "a0venice/mercury-2")
EXT_PATH = "/Users/kifir/projects/agents/pi-braid"

def run_test(name, prompt_text, timeout=30):
    """Run a single test via pi RPC mode."""
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"{'='*60}")
    
    proc = subprocess.Popen(
        ["pi", "--mode", "rpc", "--no-session",
         "--provider", PROVIDER, "--model", MODEL,
         "-e", EXT_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "OPENROUTER_API_KEY": API_KEY},
    )

    # Send prompt
    prompt = json.dumps({"type": "prompt", "message": prompt_text}) + "\n"
    proc.stdin.write(prompt.encode())
    proc.stdin.flush()

    events = []
    tool_calls = []
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
            if etype == "tool_call":
                tool_calls.append(event.get("toolName", "unknown"))
            
            if etype == "tool_execution_end":
                tool_name = event.get("toolName", "unknown")
                success = not event.get("isError")
                print(f"  Tool: {tool_name} -> {'✅' if success else '❌'}")
            
            # Get final response
            if etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for block in msg.get("content", []):
                        if block.get("type") == "text":
                            final_text += block.get("text", "")
        except json.JSONDecodeError:
            pass

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

    success = len(final_text) > 10
    status = "✅ PASS" if success else "❌ FAIL"
    print(f"\n  Status: {status}")
    if final_text:
        preview = final_text[:200].replace('\n', ' ')
        print(f"  Response: {preview}...")
    print(f"  Tools called: {tool_calls}")
    print(f"  Events: {len(events)}")
    
    return success


def main():
    results = {}
    
    # Test 1: Heartbeat status tool
    results["heartbeat_status"] = run_test(
        "Heartbeat Status",
        "Use the heartbeat_status tool and tell me what you see. Don't use any other tools.",
        timeout=30,
    )
    
    # Test 2: Memory episodes (empty initially)
    results["memory_episodes"] = run_test(
        "Memory Episodes",
        "Use the memory_episodes tool with action 'list' to see if any episodes exist. Tell me the result.",
        timeout=30,
    )
    
    # Test 3: Add an episode
    results["memory_episodes_add"] = run_test(
        "Add Episode",
        'Use the memory_episodes tool with action "add", task "smoke test task", solution "ran smoke tests successfully", outcome "success", and tags ["test", "smoke"].',
        timeout=30,
    )
    
    # Test 4: Search episodes
    results["memory_episodes_search"] = run_test(
        "Search Episodes",
        'Use the memory_episodes tool with action "search" and query "smoke test". Tell me what episodes you find.',
        timeout=30,
    )
    
    # Test 5: Memory heuristics
    results["memory_heuristics"] = run_test(
        "Memory Heuristics",
        'Use the memory_heuristics tool with action "list" to see the built-in heuristics. Tell me what rules exist.',
        timeout=30,
    )
    
    # Test 6: Tool stats (empty initially)
    results["memory_tool_stats"] = run_test(
        "Memory Tool Stats",
        'Use the memory_tool_stats tool with action "list" to see tool reliability statistics.',
        timeout=30,
    )
    
    # Test 7: Conflict QA
    results["conflict_qa"] = run_test(
        "Conflict QA",
        'Use the conflict_qa tool with action "stats" to see conflict QA statistics.',
        timeout=30,
    )
    
    # Summary
    print(f"\n\n{'='*60}")
    print("SMOKE TEST SUMMARY")
    print(f"{'='*60}")
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for name, success in results.items():
        status = "✅" if success else "❌"
        print(f"  {status} {name}")
    
    print(f"\n  Total: {passed}/{total} passed")
    
    if passed == total:
        print("\n🎉 ALL TESTS PASSED!")
        sys.exit(0)
    else:
        print(f"\n⚠️  {total - passed} test(s) failed")
        sys.exit(1)


if __name__ == "__main__":
    main()

---
name: orchestrator
description: "Coordinate mastership transfers between agents in a multi-agent system. Use when: spawning successor agents, transferring context between sessions, managing agent lifecycles, or coordinating parallel agent workers."
trigger: "mastership transfer, spawning successor agents, context transfer between sessions, agent lifecycle management, multi-agent coordination, successor handoff"
---

# Orchestrator: Mastership Transfer Protocol

## Chain

An agent that modifies code is NEVER the agent that verifies it.
The verifier is always a fresh session with the compiled changes.

```
Master → spawns Child → child modifies code
  → child spawns Grandchild (fresh session, latest release)
  → Grandchild: build, test, typecheck, verify
  → If pass: Grandchild closes Child, closes Master, takes over
  → If fail: Grandchild calls Child ("parent, fix this"), child fixes, respawns
```

## Safety Valve

If the grandchild cannot verify, it calls the parent for help instead of
propagating bad state. The parent fixes the issue, releases the fix, and
spawns a new grandchild.

## Exit

- The agent that closes itself is the one that successfully verified
- All ancestors are closed by the successor
- No agent lingers after transfer

## Wake-up Discrimination

Braid whispers fire with `triggerTurn: true` which wakes the agent. The
agent MUST distinguish:
- **Timer fire**: system wake-up, not user input. Check timer reason, do
  not assume user answered.
- **User message**: actual user input. Respond normally.

When woken by a timer: re-read the scratchpad, check what was pending,
continue without assuming the user replied.

## Non-blocking Orchestration

Master never blocks on workers. Set a timer, do other work, check at
natural turn boundaries. Workers run independently in their own sessions.

## Generic Use Cases

Orchestration works for any parallelizable task, not just code:

- **Presentation creation**: spawn workers for each slide, each worker
  researches and drafts its slide, master assembles the final deck.
- **Bug hunting**: spawn workers for each page/module, each worker reviews
  and reports bugs. One-shot review can uncover 30+ bugs in minutes.
- **Widget generation**: 1000+ widgets, 100 pages — spawn workers in
  batches, each worker handles a batch, master assembles.
- **Research**: spawn workers for each topic, each worker researches and
  summarizes, master synthesizes.

## Parent-Child Link

The child MUST know the parent's pane ID to close it on successful
handoff. The master passes its pane ID explicitly:

```
Master: "I am w3:p1. Your task is X. When done, close w3:p1."
Child: receives pane ID, stores it, uses it on completion.
```

The child stores the parent pane ID in its scratchpad so it survives
compaction. Without this, the child cannot locate the parent to close it.

## Wake-up Discrimination

Braid whispers fire with `triggerTurn: true` which wakes the agent. The
agent MUST distinguish:
- **Timer fire**: system wake-up, not user input. Check timer reason, do
  not assume user answered.
- **User message**: actual user input. Respond normally.

When woken by a timer: re-read the scratchpad, check what was pending,
continue without assuming the user replied.

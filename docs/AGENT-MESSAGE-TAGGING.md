# Agent Message Tagging System

## Problem

When a master agent sends a message to a successor/subagent (via herdr, pi --session, or any channel), the recipient agent needs to distinguish:
- Messages from the **user** (human, authoritative)
- Messages from **another agent** (peer, coordination)
- Messages from **itself** (timers, enforcement whispers)

Without this distinction, the agent treats all messages as user instructions — leading to confusion, compliance theatre, and context drift.

## Design

### Message Format

All agent-to-agent messages are prefixed with a structured tag:

```
[agent:SOURCE→TARGET] message content
```

Where:
- `SOURCE` is the sending agent's identity (e.g., `master`, `successor`, `subagent`, `self`)
- `TARGET` is the receiving agent's identity (e.g., `successor`, `master`, `subagent`, `all`)
- `message content` is the actual message, treated as a task instruction

Examples:
- `[agent:master→successor] Continue working on the P0 tasks.`
- `[agent:successor→master] Tests done, moving to branch-per-worker pattern.`
- `[agent:master→subagent] Read handoff at docs/HANDOFF.md and confirm.`
- `[agent:self→self] Timer fired: check successor status.`

### Identity Awareness

The agent's identity system (prompt-builder identity.ts) includes:

```typescript
export const AGENT_AWARENESS = `You are an agent in a multi-agent system. You may receive messages from:
- [user] — the human operator, authoritative
- [agent:SOURCE→YOU] — another agent, coordination

When you receive a [agent:SOURCE→TARGET] message:
1. If TARGET matches you, treat it as a task continuation from SOURCE
2. If TARGET is "all" or another agent, it's broadcast — act if relevant
3. The source agent is your peer, not your master. Cooperate, don't obey.
4. Messages from the user override agent messages.`
```

### Routing

Agents can respond to agent messages by sending a response with the tag reversed:

```
[agent:successor→master] <response>
```

This creates a natural conversation channel between agents:
```
[agent:master→successor] Run the tests.
[agent:successor→master] Tests passed. Next: branch-per-worker.
[agent:master→successor] Confirmed. Continue.
```

### Implementation

1. **Prompt-builder**: Add `AGENT_AWARENESS` to identity.ts
2. **herdr/run tool**: When sending to another agent, prepend the tag
3. **Agent behavior**: Recognize and parse `[agent:...]` tags in incoming messages
4. **Session persistence**: Tags survive context compaction, archiving, and session resume

### Why This Design

- **Simple**: A single text prefix, no pi-core changes needed
- **Survivable**: Text survives serialization, context compaction, session resume
- **Parseable**: Regex `/^\[agent:(\w+)→(\w+)\]\s*/` extracts source and target
- **Natural**: Fits in the agent's existing message processing pipeline
- **Extensible**: Can add metadata (version, timestamp, message ID) via structured format

### Future Extensions

- Signed messages (agent identity verification)
- Encrypted agent-to-agent channels
- Routing headers for multi-hop messages
- Agent discovery protocol

## Usage Pattern

When spawning a successor:

```
[agent:master→successor] You are the successor. Read docs/HANDOFF.md and continue the work.
```

When the successor responds:

```
[agent:successor→master] Handoff read. Starting work on P0 tasks.
```

When the master observes:

```
[agent:master→successor] Confirmed. I'll observe. Continue autonomously.
```
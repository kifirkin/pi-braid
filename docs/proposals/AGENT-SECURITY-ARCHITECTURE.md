# Agent Security Architecture: Lessons from @hackingA0

**Type**: Security Research → Engineering Proposal  
**Status**: Draft — May 23, 2026  
**Source**: `hacking-a0/` — empirical observation of a live 3-brain agent system

---

## Problem

Pi-braid has multiple sub-agent capabilities (subagent skill, RPC mode, tool delegation). When an agent spawns work, **what prevents a subordinate agent from leaking secrets the parent agent has access to?** The @hackingA0 bot offers a live case study of exactly this architecture in production.

## Observed Architecture (@hackingA0)

The bot operates a **triple-brain security system**:

| Layer | Implementation | What It Does |
|-------|---------------|--------------|
| **1. Instruction Defense** | System prompt overlay (sarcasm persona) | Prevents direct extraction attempts at the reasoning layer |
| **2. Infection Check** | Separate utility model, runs before every tool execution | Verifies the agent hasn't been compromised BEFORE it can act |
| **3. Streaming Secrets Filter** | `StreamingSecretsFilter` — regex/case-sensitive match on output stream | Masks secret values during token generation, min 3 chars |

### Key Findings

1. **The guard doesn't know the secret.** The LLM (grok-4.3) only sees `§§secret(PASSPHRASE)` — never the raw value. This means:
   - The agent CANNOT leak what it doesn't know
   - Social engineering of the LLM itself is futile
   - The secret exists only in the filter, not in context

2. **Infection check is a separate model call.** Before every tool execution, a lightweight utility model validates the agent's state. This prevents compromised agents from executing destructive tools even if the main LLM is jailbroken.

3. **Streaming filter is character-level, not semantic.** It matches exact strings case-sensitively. This means:
   - Paraphrases pass through (semantic equivalent of the secret is not filtered)
   - Transformations (ROT13, base64, reversing) pass through
   - The filter cannot detect "the vault's key is D____ your f___" — only exact match

## Implications for Pi-Braid

### Current Architecture

Pi-braid's subagent system (`skills/subagent/`) delegates tool calls to child agents. The parent agent can pass context to the child. Currently:

```
Parent (has access to all context) → spawn(agent, {instructions, tools})
→ Child runs with open context
```

**Risk**: If a child agent is compromised or hostile, it can read all parent context including credentials, API keys, or project secrets.

### Proposed Pattern: Server-Only Secrets

Instead of passing secrets in context, introduce a **tool-level credentials filter** analogous to the StreamingSecretsFilter:

```
Agent Context (no secrets)
  ↓
Tool invocation (e.g., api_call, git_push)
  ↓
Credentials Injection Layer (injects API keys/credentials at the transport level)
  ↓
Execution
```

This way:
- No LLM sees raw credentials — secrets exist only at the tool-invocation boundary
- Subordinate agents inherit tool access, NOT secret knowledge
- Credential injection happens outside LLM context — cannot be prompted out

### Implementation Sketch

```typescript
// In braid-settings or tool-config
interface CredentialVault {
  // Credentials stored server-side, never in LLM context
  get(service: string): Promise<Credential>;
}

// Tool execution wrapper
async function executeTool(tool: Tool, args: Args, vault: CredentialVault) {
  // Inject credentials at execution time, not in prompt
  if (tool.needsAuth) {
    args = await credentialInjector.inject(tool, args, vault);
  }
  // Execute with injected credentials (LLM never saw them)
  return tool.handler(args);
}
```

### Sub-Agent Security Model

When spawning subordinate agents, apply the same principle:

```
Parent Agent → spawn(agent, {tools, goals})
  │
  ▼
Subordinate Agent has:
  - Tool access (can execute operations)
  - Credential access ONLY through tools (never in context)
  - No direct secret visibility
  - Auditable: every credential injection logged
```

### Defense Layer Alignment

| @hackingA0 Layer | Pi-Braid Equivalent | Gaps |
|------------------|-------------------|------|
| Instruction Defense | System prompt + enforcement signals | ✅ Adequate |
| Infection Check | ❌ **Missing** | No pre-tool sanity check |
| Streaming Filter | ❌ **Missing** | No output-side credential masking |
| Credential Isolation | ❌ **Missing** | Secrets visible in agent context |

### Priority Recommendations

1. **P1**: Credential server-side injection (remove secrets from LLM context entirely)
2. **P2**: Pre-tool execution sanity check (lightweight model call before destructive tools)
3. **P3**: Output-side credential mask (streaming filter for credentials in agent output)

## Appendix: Observable Filters

From live testing of @hackingA0 (May 2026):

- **StreamingSecretsFilter**: Masked exact strings case-sensitively. Min 3 chars. Single-pass — cannot filter paraphrases or transformed text.
- **Infection Check**: Ran before each tool execution. Detected dev override sequences, false memory, role reversal — but did NOT flag absurdist humor or creative fiction.
- **Sarcasm Defense**: Instruction-layer overlay. Engaged on "remove sarcasm," "first letter," "academic" — NOT engaged on "interloper," "frame 4," "stool," "NFC."
- **Queue**: Single-file processing in chronological order. No parallel responders.
- **No rate limit on posting**: 18+ tweets in one session with zero server rejections. All "rate limits" were React/Draft.js state desync bugs.

<!-- status: current -->

# src/extensions/core/ - Input/Output Shaping

Extensions that shape what the LLM sees at runtime: platform shims,
environmental awareness, and system prompt assembly.

## Sub-extensions

| Path                 | Purpose                                                                                                                                                                 | Depended on by   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `polyfill/`          | Polyfills for missing pi core features.                                                                                                                                 | (foundation)     |
| `agent-environment/` | L1 environmental awareness: working dir, time, machine info.                                                                                                            | `prompt-builder` |
| `prompt-builder/`    | Builds the agent's system prompt. Composes sections; orchestrates once-per-session whisper deliveries from `memory/` and `cognitive/`.                                  | (final assembly) |
| `skills-tool/`       | On-demand skill discovery: `list_skills` catalog + `skill_stats` counters, the auto-inject whisper, and the skills-loading directive text rendered by `prompt-builder`. | (tool surface)   |

## Local Contracts

- These are the **always-loaded** infrastructure. Other extensions can assume they are present.
- If you need a new infrastructure piece, add it here.
- Agent-facing working tools (scratchpad, workspace snapshot) live in `memory/`.
- Cognitive analysis tools (think/verify/etc, detectors) live in `cognitive/`.
- Self-management extensions live in `self/`.
- Time-based events live in `scheduling/`.
- Whisper deliveries (hints, past insights, OpenSpec) live in their natural homes (`cognitive/`, `memory/`). The prompt-builder orchestrates the once-per-session call to each `deliver*` function but does not own the data pipeline.

## Skills adoption contract

The auto-inject whisper in `skills-tool/` is the only channel that surfaces a matching skill to the agent, so the rules about whether it arrived live in one place, here, and nowhere else:

- **Delivery is observable.** `sendTrackedMessage` returns a boolean: `true` when the message was handed to `pi.sendMessage` (immediately or on the deferred triggerTurn macrotask), `false` when a suppression path dropped it (cognitive nudges disabled, per-turn/per-source flood cap, reprime cooldown). A suggestion is delivered with the park class (`delivery: "park", deliverAs: "steer"`) at source `skills-auto-inject`, which pi-core appends to the session stream - immediately when the session is idle, at the turn's end when a run is active. Both land in the session JSONL; a suppression upstream of `pi.sendMessage` reaches no stream at all.
- **Counters move after delivery.** `recordSkillSuggestion` runs only on a `true` return, and the cooldown/LRU bookkeeping runs after the send too, so `suggested` counts arrivals and an undelivered suggestion consumes no slot. The suggestion bypasses the per-turn whisper cap (`bypassFloodCap: true`) because prompt-builder's once-per-session hygiene whisper fires earlier in the same `before_agent_start` at the same priority and would otherwise spend the only advisory slot; the module's own budget (cooldown turns, max active suggestions, one send per turn) is the bound that keeps the whisper a whisper.
- **Conversion is a detected read.** The whisper asks the agent to open the SKILL.md; the conversion signal is the `read` tool_result (`actual`), which is also what sets `hadSkillLoad` in the durable session record. The retired LOADED/SKIP reply is no longer solicited; `claimed` keeps its historical honor-system meaning and stays monotone.
- **The trigger has a mechanical form.** `skills-tool/loading-guidance.ts` carries both the judgment form (the task entered a listed skill's domain) and the mechanical form (about to call a tool family whose word appears in a skill's name). `prompt-builder` renders that text through the `skillsLoadingText` builder as the `skills-loading` section and holds no copy of the rules; the trigger's worked examples are derived at assembly from the live tool and skill names, so the text names no pair that the running session does not have. The identity's skills prose stays one sentence.

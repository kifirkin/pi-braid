<!-- status: current -->

# src/extensions/core/ - Input/Output Shaping

Extensions that shape what the LLM sees at runtime: platform shims,
environmental awareness, and system prompt assembly.

## Sub-extensions

| Path                 | Purpose                                                                                                                                                                                                       | Depended on by   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `polyfill/`          | Polyfills for missing pi core features.                                                                                                                                                                       | (foundation)     |
| `agent-environment/` | L1 environmental awareness: working dir, time, machine info.                                                                                                                                                  | `prompt-builder` |
| `prompt-builder/`    | Builds the agent's system prompt. Composes sections; orchestrates once-per-session whisper deliveries from `memory/` and `cognitive/`.                                                                        | (final assembly) |
| `skills-tool/`       | Skill surface: `list_skills` catalog (on-demand reach and ranking) + `skill_stats` counters, the auto-inject whisper, the skills floor (visible catalog) and drift trigger text rendered by `prompt-builder`. | (tool surface)   |

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
- **The catalog is in the prompt.** The same section renders every visible skill as one `- name: description` row, with the read path derived from the skills' own file paths (one root for a single pack, a directory heading per pack when a catalog is installed from several). A tool call is no longer the way the agent learns which skills exist: the floor exists because the prompt that opens a resumed session carries no domain vocabulary for a matcher to rank against. `list_skills` remains the price tool (reach, headings, ranking) rather than the catalog.
- **Drift re-points at the floor.** When the session's own path-taking calls (`read`/`edit`/`write`) accumulate entries in a work area the floor was not rendered against, one steer line names that area and points back at the catalog. The rule and its bounds (two entries, one fire per twelve calls, three per session, quiet for the same window after any skill surface) live in `loading-guidance.ts` beside the floor text; the wiring is the `tool_result` handler in `auto-inject.ts`. Bounds are the whole design: the line is only worth its noise if it stays rare.
- **Applicability is recorded, never enforced.** The counters cannot tell a skill that applied and was ignored from one that never applied, and the sessions that read nothing are mostly sessions no phrase matches. `skills-tool/applicability.ts` decides that difference from the skill's own declaration (the trigger phrases its file carries: frontmatter `trigger:`/`triggers:`, a `## trigger:` body heading, a description `Triggers:` tail), never from the ranking heuristic, with the injector's occurrence boundary and a clause-scoped negation read, so a phrase inside "do not research this" is not a condition met. The verdict is `read` (condition held and a detected read followed), `ignored` (condition held and no read followed), or `not-applicable` (derived: the census's `evaluated` minus the verdict rows); a skill whose file declares no phrase is named `undeclared` rather than judged either way. It reaches disk as `kind: "applicability"` rows in the per-session store (one verdict row per applicable skill keyed on `sessionId` + `skill`, one census row per session) and out through `skill_stats`. It is an observer: it writes no delivery, slot, cooldown, counter or prompt, and it owns no compliance leg. `suggested`/`listed`/`read`/`applied` belong to the record that owns each skill's declared tool family; the verdict row joins it on the skill name.

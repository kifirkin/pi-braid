# Researcher's Prompt & Tool Guidelines — Deep Analysis & Improvement Proposal

**Date**: 2026-05-08
**Reviewer**: Braid architect agent
**Scope**: Tone-quality SKILL.md, promptSnippet system, prompt-builder architecture

---

## Executive Summary

The researcher agent built a **three-layer system** for prompt quality:

1. **Tone Quality Skill** (`skills/tone-quality/SKILL.md`) — 4-dimension diagnostic framework
2. **promptSnippet System** — Clean one-sentence tool descriptions in system prompt
3. **Prompt Builder** (`src/extensions/prompt/prompt-builder/index.ts`) — Structured prompt reconstruction

**Overall verdict**: Well-researched, empirically grounded, and largely self-consistent. The system prompt correctly uses identity framing over directives. Tool descriptions are clean. The prompt builder builds from structured data, not string extraction.

**However**, there are gaps between the guidelines and the actual runtime behavior that can be tightened.

---

## Layer 1: Tone Quality Skill — Analysis

### What's Good

The 4-dimension framework is **rigorous and empirically backed**:

| Dimension | Theory | Evidence | Verdict |
|-----------|--------|----------|---------|
| 1. Directive Density | Identity framing > directives | 3.3× speed, 0-38% vs 100% compliance | ✅ Strong |
| 2. Cognitive Reasoning Density | "Think silently" > "Think step by step" | 2-3× token waste from verbose chains | ✅ Strong |
| 3. Voice Artifacts | Statistical patterns reveal generation | Measurable fingerprints (tricolon, em dash) | ✅ Good |
| 4. Epistemic Calibration | Match confidence to production pathway | 4-level pathway taxonomy | ✅ Good |

The decision tree is practical and the "Anti-pattern: Empty System Prompt" section is a valuable insight (0% code quality without any prompt).

### What's Missing

1. **No tool description guidelines** — The skill covers prompts and text, but doesn't address how to write tool descriptions (the `promptSnippet` and `description` fields). This is a separate craft: tool descriptions must be both machine-parseable (parameter docs) and human-readable (agent understanding).

2. **No system prompt section guidelines** — How to structure multi-section prompts (identity, tools, skills, environment). What order? How much context is too much? The skill says "be concise" but doesn't quantify.

3. **No interaction between dimensions** — What happens when Dimension 1 (identity) conflicts with Dimension 4 (calibration)? Example: "You are a rigorous engineer" might trigger compliance behaviors around verification, even though the intent is identity-based.

4. **Em dash rule is controversial** — The claim "em dash is an LLM artifact" is not universally accepted. Many human writers (especially technical writers) use em dashes deliberately. This might be a style preference masquerading as a signal.

---

## Layer 2: promptSnippet System — Analysis

### Architecture

Each tool has two description fields:
- **`promptSnippet`**: One-sentence summary, used in system prompt's "Available tools:" listing
- **`description`**: Full documentation including usage patterns, parameters, caveats

The prompt builder uses this logic:
```
if (KNOWN_SNIPPETS[tool.name]) → use hardcoded snippet (pi-native tools)
else → use full tool.description (braid tools)
```

### What's Good

- Clean separation of concerns: listing vs documentation
- pi-native tools get stable one-liners across versions
- Braid tools use their `description` field directly (no separate maintenance)

### What Could Be Better

1. **Inconsistency: some braid tools have promptSnippet, others don't**
   - `memory_episodes` has: `"Search retrospective episodes for similar past tasks"`
   - But `think` tool has a promptSnippet that IS used
   - The prompt builder ignores promptSnippet for braid tools and uses full description
   - This means braid tools' one-line promptSnippets are **dead code** — they're defined but never read

2. **Full description in tool listing is verbose**
   - When a braid tool has a 3-line description, the entire thing appears in the system prompt's tool listing
   - The researcher's intent was one-line summaries, but the implementation only enforces this for pi-native tools
   - Token waste: every tool's full description is in the prompt on every turn

3. **Hardcoded KNOWN_SNIPPETS could drift**
   - If pi-native changes a tool name or adds new tools, the hardcoded map becomes stale
   - Better: extract first sentence dynamically for all tools

---

## Layer 3: Prompt Builder — Analysis

### Current Architecture

The prompt builder constructs the system prompt from 10 sections:

```
1. IDENTITY_INTRO (identity framing)
2. SYCOPHANCY_RESISTANCE (research-backed guardrail)
3. STAKES_AWARENESS (research-backed guardrail)
4. Available tools (from getAllTools())
5. Project context (AGENTS.md/CLAUDE.md)
6. Skills (with line counts and section names)
7. Past insights (from episodes + sessions)
8. L1 environment (date, mode, session metrics)
9. Enforcement signals (active violations)
10. Contrast mode (truth-seeking vs sycophancy resistance)
11. INTERACTION_STYLE (single sentence)
12. appendSystemPrompt (pi-native additions)
13. Date + CWD
```

### What's Good

- Identity framing follows Dimension 1: "You are Braid, an expert software architect"
- No MUST/ALWAYS/NEVER in the system prompt text
- Structured data approach (no fragile string extraction)
- Research citations in comments (2604.19117, 2604.15224)
- Concise guardrails (single sentence each)

### What Could Be Better

1. **Tool listing uses full descriptions, not snippets**
   ```typescript
   .map((t) => `- ${t.name}: ${KNOWN_SNIPPETS[t.name] ?? t.description}`)
   ```
   For braid tools without KNOWN_SNIPPETS, this uses the FULL description.
   A tool with a 200-char description gets all 200 chars in the system prompt.
   With 60+ tools, this is ~6000-12000 tokens of tool descriptions per turn.

2. **Past Insights section can inject noise**
   - The `searchPastInsights` function loads the last 5 episode lines and 3 session files
   - If episodes are generic ("session_outcome: success"), they add noise
   - The `hasSignal` filter helps but doesn't catch all noise patterns

3. **L1 environment can be large**
   - `formatL1Environment` includes session metrics, active mode, etc.
   - On long sessions, this can be verbose

4. **Skills section includes ALL skills (15+), with full metadata**
   - Every skill gets name, description, location, lines, sections
   - That's ~15 skills × 5-10 lines each = ~100 lines of skill metadata

---

## Proposed Improvements

### P0: Tool Description Truncation (High Impact, Low Effort)

**Problem**: Braid tool descriptions are used verbatim in the system prompt listing.
**Fix**: Extract first sentence for all tools, matching the promptSnippet pattern.

```typescript
function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]/);
  return match ? match[0].trim() : text.split('\n')[0].trim();
}

// In reconstructToolsSection:
.map((t) => `- ${t.name}: ${KNOWN_SNIPPETS[t.name] ?? firstSentence(t.description)}`)
```

**Estimated token savings**: ~4000-8000 tokens per turn (60 tools × 50-100 chars saved each).

### P1: Remove Dead promptSnippet Fields (Cleanup)

**Problem**: Many braid tools define `promptSnippet` but it's never read by the prompt builder.
**Fix**: Either (a) use promptSnippet in the builder, or (b) remove the dead fields.

Option A is better — it lets tool authors control their one-line summary:

```typescript
.map((t) => `- ${t.name}: ${KNOWN_SNIPPETS[t.name] ?? t.promptSnippet ?? firstSentence(t.description)}`)
```

### P2: Tone-Quality Audit of Tool Descriptions (Medium Effort)

**Problem**: Some tool descriptions may have voice artifacts or unnecessary verbosity.
**Fix**: Run the 4-dimension tone-quality framework over all tool descriptions.

Checklist for each tool:
- [ ] No MUST/ALWAYS/NEVER/CRITICAL/REQUIRED
- [ ] No "think step by step" or "show reasoning"
- [ ] No signposting ("Great question!", "Let's dive in")
- [ ] Confidence calibrated (no "clearly", "obviously")
- [ ] One-sentence summary in promptSnippet

### P3: Add Tool Description Guidelines to Tone-Quality Skill (Medium Effort)

**Problem**: The tone-quality skill doesn't cover tool description writing.
**Fix**: Add a 5th dimension or a subsection covering tool description best practices:

```markdown
## 5. Tool Description Clarity

Tool descriptions serve two audiences: the agent (decides when to use the tool)
and the developer (reads parameter docs).

Rules:
- promptSnippet: ≤15 words, declarative, starts with a verb
- description: 1-3 sentences, covers purpose + when to use + key caveats
- No instructions in description (those go in the system prompt or skill)
- Parameter descriptions: noun phrases, not sentences
```

### P4: Past Insights Noise Filter (Medium Effort)

**Problem**: Generic episode entries ("session_outcome: success") add noise.
**Fix**: Require minimum content length AND keyword diversity:

```typescript
const hasSignal = (content: string): boolean => {
  if (content.trim().length < 30) return false;  // Too short
  if (/^(session_outcome|outcome):/i.test(content.trim())) return false;
  if (content.split(' ').length < 5) return false;  // Too few words
  return true;
};
```

### P5: Dynamic Section Budget (Future)

**Problem**: The prompt has no token budget enforcement — sections grow unbounded.
**Fix**: Add a token budget per section and truncate or omit sections that exceed it.

This is a larger change but would prevent the prompt from growing past the model's effective context window.

---

## Quick Wins (Can Do Now)

1. **Truncate tool descriptions to first sentence** — 1-line change in prompt-builder, saves ~5000 tokens/turn
2. **Use promptSnippet when available** — 1-line change, respects tool author intent
3. **Remove dead promptSnippets** — or wire them up (see P1)

## Medium Investment (Next Sprint)

4. **Audit all tool descriptions against tone-quality** — ~60 tools, ~1 hour
5. **Add tool description guidelines to tone-quality skill** — documentation
6. **Improve past insights noise filter** — prevent generic episode injection

## Strategic Investment (v0.3.0)

7. **Dynamic section budget** — prevent prompt bloat
8. **Research: measure impact of each section** — A/B test prompt variants
9. **Investigate context_prune blocker** — enable autonomous overnight sessions

---

## Summary

The researcher's work is **genuinely good**. The 4-dimension framework is practical and well-grounded. The identity-based system prompt avoids compliance theater. The promptSnippet concept is sound.

The main gap is **implementation completeness**: the guidelines are defined but not fully enforced in code. The prompt builder still uses full descriptions instead of snippets, and tool authors define promptSnippets that are never read.

The highest-impact fix is **P0: first-sentence truncation** — one line of code, thousands of tokens saved per turn.

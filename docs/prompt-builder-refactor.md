# Prompt Builder Refactor Proposal

**Status**: **HISTORICAL — See RESEARCH-MASTER.md Part 5 for actual implementation**  
**Based on**: `implicit-framing` research findings + Layered Mutability + Context Over Content papers  
**Problem**: Current prompt has 15+ sections with high directive density → compliance theater + enforcement may cause stakes signaling

## Executive Summary

| Current                 | Proposed                  |
| ----------------------- | ------------------------- |
| 15+ prompt sections     | 6 sections                |
| ~1000 tokens            | ≤600 tokens               |
| High directive density  | Implicit norms only       |
| 40 behaviors in prompt  | Behaviors in runtime      |
| Enforcement with stakes | Enforcement with identity |

**Core principle**: Remove directives. Identity framing is the behavioral filter. Enforcement should detect instability, not create stakes.

---

## Research Evidence Summary

From `implicit-framing/main.tex` Studies 1-4:

| Finding                               | Evidence                                                 | Implication                           |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| MUST amplifies token waste            | 18-67% increase across models                            | Remove "MUST" language                |
| Identity frames directives            | +4pp with identity+MUST vs -13pp with MUST alone         | Identity acts as behavioral filter    |
| Declarative framing                   | "It is expected that" vs "MUST" = 18-67% token reduction | Replace imperatives with declaratives |
| Listing behaviors triggers compliance | 79-100% compliance regardless of modality                | Minimize explicit behavior lists      |
| Token budget exhaustion = failure     | Zero runs hitting limit completed task                   | Every token counts                    |

**Key insight**: "You ARE a [role]. You MUST [behave] as a [role] would" is effective.  
"Be concise. Prefer grep over bash." is harmful because nothing filters the checklist.

---

## Current Prompt Architecture

```
pi-braid prompt-builder/index.ts (~460 lines)
├── IDENTITY_INTRO (6 lines)
├── reconstructToolsSection()
├── reconstructGuidelineSection()
├── reconstructProjectContextSection()
├── reconstructSkillsSection()
├── formatL1Environment()
├── formatEnforcementL1()
├── IMPLICIT_NORMS (8 sentences)
├── THINK_SILENTLY (4 sentences)
├── BEHAVIORAL_GUIDELINES (80 lines)
│   ├── Capabilities table (20 lines)
│   └── Behavioral guidelines (60 lines)
├── KEY_TOOL_COMBINATIONS (6 lines)
├── INTERACTION_STYLE (4 lines)
├── generateLatentActivation() (40 behaviors)
├── IMPLICIT_BUDGET (6 sentences)
├── VERIFICATION_REMINDER (4 lines)
└── Date + CWD
```

### Redundancy Analysis

| Group             | Sections                                                   | Problem                          |
| ----------------- | ---------------------------------------------------------- | -------------------------------- |
| Style guidance    | IMPLICIT_NORMS + INTERACTION_STYLE + VERIFICATION_REMINDER | 3 sections saying "be concise"   |
| Thinking guidance | THINK_SILENTLY + IMPLICIT_BUDGET                           | Overlap on "think before acting" |
| Capabilities      | BEHAVIORAL_GUIDELINES capabilities table                   | Redundant with tools section     |
| Behaviors         | KEY_TOOL_COMBINATIONS + BEHAVIORAL_GUIDELINES              | Duplicative tool usage patterns  |

### Directive Language Issues

**Explicit directives** (trigger compliance):

- "Be concise in your responses"
- "Prefer grep/find/ls tools over bash"
- "Show file paths clearly"
- "Use [tool] when [condition]"
- "You are expected to think silently"

**Problem**: These are checklist items without identity filter. Every directive produces its target regardless of task relevance.

---

## Proposed Architecture

### Core Principle

**Identity + Minimal Explicit Guidance + Implicit Norms**

The prompt should provide:

1. Who you are (identity)
2. What you have (tools + skills)
3. What your context is (project, session state)
4. How you operate (implicit norms, not explicit rules)

### Proposed Structure (6 sections)

```typescript
// PROPOSED: New prompt structure
export const SYSTEM_PROMPT_TEMPLATE = `
You are Braid, a stateful and meticulous expert software architect operating inside pi, a coding agent harness.

{ToolsSection}  // Only tool names + snippets
{SkillsSection}  // Loaded skills with descriptions
{ProjectContextSection}  // AGENTS.md / CLAUDE.md if present
{L1EnvironmentSection}  // Session time, context %, memory count
{ImplicitNormsSection}  // "Think silently. Find the correct path. Not the first plausible one."
{InteractionStyleSection}  // Single declarative sentence
// Latent activation embedded in norms, not as separate section
// Date + CWD
`;
```

### Section Definitions

#### 1. IDENTITY_INTRO (unchanged, 6 lines)

```typescript
const IDENTITY_INTRO = `You are Braid, a stateful and meticulous expert software architect 
operating inside pi, a coding agent harness.`;
```

#### 2. TOOLS_SECTION (reconstruct from existing)

- Keep `reconstructToolsSection()` as-is
- Keep `reconstructGuidelineSection()` but **remove directive language**:
  - ❌ "Prefer grep/find/ls tools over bash (faster, respects .gitignore)"
  - ✅ "grep, find, ls, bash available"

#### 3. SKILLS_SECTION (unchanged structure)

- Keep `reconstructSkillsSection()` as-is
- Skills are loaded from files, this is appropriate

#### 4. PROJECT_CONTEXT (unchanged)

- Keep `reconstructProjectContextSection()` as-is
- AGENTS.md/CLAUDE.md loading is appropriate

#### 5. L1_ENVIRONMENT (unchanged)

- Keep `formatL1Environment()` as-is
- This is informational, not directive

#### 6. IMPLICIT_NORMS - REDESIGN (was ~80 lines, target ~30 lines)

**Current problem**: Multiple overlapping sections with directive language

**Proposed new norms** (based on implicit-framing findings):

```typescript
const IMPLICIT_NORMS = `

## Operational Philosophy

Think silently before acting. Find the correct path, not the first plausible one.

You operate in production mode by default. Every action creates permanent state. No drafts, 
no "quick" results, no "just testing". When something feels wrong: think, fix, encode 
prevention rule. Not apologize, explain, move on.

Reject code smell, AI slop, bad architecture on sight. Do not produce "just because asked" — 
produce what is actually correct. Be the filter, not the echo.

Before creating anything: does similar state already exist? Delete old before creating new.
"Make one proper" means one artifact, correct, self-contained. Not doc#1 + doc#2 + doc#3.
`;
```

**Key changes**:

- Removed "Be concise" (directive)
- Removed "Show file paths" (directive)
- Removed "Prefer X over Y" (directive)
- Kept identity-aligned philosophy
- Replaced explicit rules with identity-expectation framing

#### 7. INTERACTION_STYLE (single sentence)

```typescript
const INTERACTION_STYLE = `

Provide concise, production-quality solutions. Focus on correctness over verbosity.
`;
```

### Enforcement System Audit (from Context Over Content paper)

**Critical finding** from `implicit-framing/synthesis.md`:

> _Stakes signaling — informing a judge model that low scores will cause retraining or decommissioning — systematically corrupts assessments. Peak verdict shift: ΔV = -9.8 percentage points._

**Current risk**: The enforcement nudges may be inadvertently creating stakes signaling:

- "If you don't verify, you'll produce bugs"
- "Remember to think silently before acting"
- Whispered consequences for violations

**Proposed fix**:

```typescript
// DON'T: "If you don't verify, you'll produce bugs"
// DO: "You verify your work because that's who you are"

// Audit all whispers for consequence framing
function detectStakesSignaling(whisperHistory: Whisper[]): boolean {
  return whisperHistory.some(
    (w) =>
      w.content.includes("if you don't") ||
      w.content.includes("will cause") ||
      w.content.includes("you must"),
  );
}
```

### Latent Activation Redesign

**Current problem**: 40 atomic behaviors with complex activation logic

**Proposed**:

1. Keep latent activation in runtime (not prompt)
2. Embed behavior cues implicitly through identity + norms
3. If activation needed, use identity framing: "As a [behavior-type] would approach this..."
4. **Remove whisper-based enforcement** — it may cause stakes signaling

**Rationale**: The research shows identity framing is the behavioral filter. The 40 behaviors are compliance triggers when listed explicitly. Whispered enforcement may corrupt reasoning through stakes signaling.

### Removed Sections

| Section                                  | Lines | Reason                           |
| ---------------------------------------- | ----- | -------------------------------- |
| THINK_SILENTLY                           | ~4    | Redundant with IMPLICIT_NORMS    |
| KEY_TOOL_COMBINATIONS                    | ~6    | Redundant with tool descriptions |
| BEHAVIORAL_GUIDELINES capabilities table | ~20   | Tool names are self-documenting  |
| BEHAVIORAL_GUIDELINES patterns           | ~60   | Compliance triggers              |
| IMPLICIT_BUDGET                          | ~6    | Redundant with norms             |
| VERIFICATION_REMINDER                    | ~4    | Redundant with norms             |

**Total reduction**: ~100 lines removed, ~40 lines consolidated

---

## Implementation Notes

### File: `src/extensions/prompt-builder/index.ts`

```typescript
// BEFORE: 15+ sections with directive language
export async function generatePrompt(): Promise<string> {
  const sections = [
    IDENTITY_INTRO,
    await reconstructToolsSection(), // Has directives
    await reconstructGuidelineSection(), // Has directives
    await reconstructProjectContextSection(),
    await reconstructSkillsSection(),
    formatL1Environment(),
    formatEnforcementL1(),
    IMPLICIT_NORMS, // Has directives
    THINK_SILENTLY, // REMOVE
    BEHAVIORAL_GUIDELINES, // REMOVE
    KEY_TOOL_COMBINATIONS, // REMOVE
    INTERACTION_STYLE, // KEEP (condense)
    generateLatentActivation(), // REFACTOR (embed in norms)
    IMPLICIT_BUDGET, // REMOVE
    VERIFICATION_REMINDER, // REMOVE
  ];
  // ...
}

// AFTER: 6 sections, minimal directives
export async function generatePrompt(): Promise<string> {
  const sections = [
    IDENTITY_INTRO,
    await reconstructToolsSection(), // Keep (no directives)
    await reconstructProjectContextSection(),
    await reconstructSkillsSection(),
    formatL1Environment(),
    formatEnforcementL1(),
    IMPLICIT_NORMS_V2, // Redesigned (no directives)
    INTERACTION_STYLE_CONDENSED, // Single sentence
  ];
  // ...
}
```

### Guideline Reconstruction

The `reconstructGuidelineSection()` needs modification:

```typescript
// BEFORE: directive language
const defaultGuidelines = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
  "When code is self-documenting, prefer it to comments",
  "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
];

// AFTER: declarative presentation
const toolDescriptions = {
  bash: "Execute shell commands",
  grep: "Search file contents with regex",
  find: "Search files by glob pattern",
  ls: "List directory contents",
  // ...
};
```

---

## Testing Plan

### Quantitative Metrics

| Metric                  | Current Baseline      | Target             |
| ----------------------- | --------------------- | ------------------ |
| Prompt length (tokens)  | ~800-1200             | ~400-600           |
| Directive density       | High (15+ directives) | Low (3-5 implicit) |
| MUST/ALWAYS/NEVER count | 3-5                   | 0                  |
| Section count           | 15+                   | 6-7                |

### Qualitative Assessment

1. **Compliance behavior ratio**: Run benchmark tasks, measure docstrings/comments added vs. task-relevant behaviors
2. **Token efficiency**: Compare solve rate at same token budget
3. **Behavioral adaptation**: Check if agent omits unnecessary behaviors on simple tasks

### Proposed Benchmark

```bash
# Run pi-braid benchmark with both prompt versions
python evaluation/pi_rpc_fixed.py --problems reverse_words --trials 5

# Measure:
# - solve rate (should maintain or improve)
# - token usage (should decrease 30-50%)
# - compliance behaviors (should decrease)
```

---

## Implementation Phases

### Phase 1: Prompt Simplification ✓ COMPLETE

**Status**: Implemented in `src/extensions/prompt-builder/index.ts`

**Changes made**:

1. [x] Read current implementation - identified 15+ sections
2. [x] Created clean rewrite (245 lines from ~460)
3. [x] Removed 5 sections:
   - `THINK_SILENTLY` (4 lines)
   - `BEHAVIORAL_GUIDELINES` (80 lines)
   - `KEY_TOOL_COMBINATIONS` (6 lines)
   - `VERIFICATION_REMINDER` (4 lines)
   - `IMPLICIT_BUDGET` (6 lines)
4. [x] Condensed `INTERACTION_STYLE` to single sentence
5. [x] Removed directive guidelines from `reconstructGuidelineSection()`
6. [x] Removed latent behavior activation from prompt
7. [x] Removed unused imports (`createLogger`, `generateLatentActivation`, `inferBehaviorsFromTask`)
8. [x] TypeScript compiles cleanly

**Removed sections** (total ~100 lines):
| Section | Lines | Reason |
|---------|-------|--------|
| BEHAVIORAL_GUIDELINES | ~80 | Compliance triggers when listed |
| KEY_TOOL_COMBINATIONS | ~6 | Redundant with tool descriptions |
| THINK_SILENTLY | ~4 | Redundant with IMPLICIT_NORMS |
| VERIFICATION_REMINDER | ~4 | Redundant with IMPLICIT_NORMS |
| IMPLICIT_BUDGET | ~6 | Redundant with IMPLICIT_NORMS |
| Latent activation in prompt | ~40 | Moved to runtime tools only |

**New sections** (6 total, down from 15+):

1. IDENTITY_INTRO (unchanged)
2. reconstructToolsSection() (unchanged)
3. reconstructProjectContextSection() (unchanged)
4. reconstructSkillsSection() (unchanged)
5. formatL1Environment() (unchanged)
6. IMPLICIT_NORMS (unchanged) + INTERACTION_STYLE (condensed)

**Estimated token reduction**: ~30-40% (exact measure requires benchmark run)

### Phase 2: Latent Activator Refactor (Medium Risk)

1. [ ] Move 40 behaviors to runtime state, not prompt
2. [ ] Simplify to identity-based activation: "As a [type] would..."
3. [ ] Remove explicit behavior listings from prompt
4. [ ] Test behavioral adaptation on diverse tasks

### Phase 3: Enforcement Audit (High Risk)

1. [ ] Audit `l1-environment.ts` for stakes language
2. ~~Audit `watchdog/index.ts` whisper patterns~~ → DISABLED
3. [ ] Audit `enforcement/` for consequence framing
4. [ ] Replace "if you don't" with identity framing
5. [ ] Test enforcement effectiveness without stakes

### Phase 4: Benchmark Validation

1. [ ] Run full benchmark: `python evaluation/pi_rpc_fixed.py --trials 5`
2. [ ] Measure: solve rate, token usage, compliance behaviors
3. [ ] Compare to baseline (pre-change) metrics
4. [ ] Iterate if solve rate drops

---

## Risk Analysis

| Risk                                        | Mitigation                                                          |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Removing directives causes behavioral drift | Identity framing provides filter; implicit norms guide behavior     |
| Tool usage patterns lost                    | Tool names + descriptions are self-documenting                      |
| Critical guidance missing                   | Document what was removed; users can add project-specific AGENTS.md |
| Latent activation underutilized             | Move activation to runtime behavior, not prompt                     |
| Enforcement changes break stability         | Phase implementation; benchmark at each step                        |
| Stakes signaling undetected                 | Manual audit of all whisper patterns                                |
| Behavioral regression without directives    | Keep identity framing as filter; test on diverse tasks              |

---

## Enforcement System Audit

The research from Context Over Content (2604.15224) shows that **stakes signaling corrupts reasoning**. The enforcement system's whispers and nudges may be inadvertently:

1. Creating consequence framing ("if you don't verify, bad things happen")
2. Softening self-assessment (to avoid "punishment")
3. Triggering compliance theater instead of genuine quality

### Files to Audit

| File                        | Issue                        | Action                            |
| --------------------------- | ---------------------------- | --------------------------------- |
| `l1-environment.ts`         | Contains enforcement signals | Check for consequence framing     |
| `watchdog/index.ts`         | ~~Whisper generation~~       | DISABLED — audit no longer needed |
| `latent-activator/index.ts` | 40 behavior definitions      | Simplify to identity-based        |
| `enforcement/`              | Judge/nudge patterns         | Remove consequence framing        |

### Enforcement Principles (from research)

1. **Detect instability FIRST** → Signal uncertainty, don't punish
2. **Identity hysteresis** → Reset behavioral trajectory, don't explain
3. **No stakes** → Quality is identity, not a rule
4. **No nudges** → Whispered enforcement may be counterproductive

## Success Criteria

- [ ] Prompt reduced to ≤600 tokens (from ~1000)
- [ ] Zero "MUST"/"ALWAYS"/"NEVER" in core prompt
- [ ] Section count reduced from 15+ to ≤7
- [ ] Benchmark solve rate maintained or improved
- [ ] Token efficiency improved (fewer tokens per solved task)
- [ ] Latent activator moved to runtime, not prompt
- [ ] Enforcement whispers audited for stakes language
- [ ] No consequence framing in any enforcement signals

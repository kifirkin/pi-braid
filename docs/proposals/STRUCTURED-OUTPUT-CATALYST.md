# Implementation: Structured Output Catalyst for pi-braid

**Type**: Tool Enhancement  
**Based on**: MDA (2601.21996) + IRCoT (2212.10509) + CRL (2602.10437)  
**Priority**: P0 (Immediate — can implement Day 1-2)  
**Owner**: pi-braid research + overnight development

---

## The Core Idea

**MDA finding**: Repetitive structural data (LaTeX, XML) acts as a "mechanistic catalyst" for induction head formation. Induction heads are the circuits that enable in-context learning (ICL).

**IRCoT finding**: Multi-step reasoning improves when retrieval is interleaved with reasoning steps — not one-shot retrieval.

**CRL finding**: Syntactic features in early layers, semantic in later layers. Feature steering at token level works.

**Combined hypothesis**: If we format tool outputs in consistent, repetitive, structured patterns, we may catalyze the ICL circuit, making the model better at recombining skills on-the-fly.

---

## What We Change

### Before: Free-form tool output

```
Tool result: "The file has these imports: os, sys, json, and pathlib. The total count is 4."
```

### After: Structured delimited output

```
TOOL_RESULT:
TYPE: import_analysis
COUNT: 4
ITEMS: [os, sys, json, pathlib]
STATUS: success
---
```

The repetitive `TYPE: value\n` pattern acts like LaTeX/XML in training — repetitive structural format that may catalyze induction head circuits.

---

## Implementation in pi-braid

### Where to Modify

```
src/extensions/prompt-builder/reconstruct-tools.ts
  → Modify the "format tool result" function
  → Add structured output option

src/extensions/tools/index.ts
  → Or modify the tool definition to include output_format
```

### The Structured Output Format

```typescript
interface StructuredToolResult {
  TOOL: string;        // Tool name
  ACTION: string;     // What was done
  RESULT: string;     // Result summary
  STATUS: 'success' | 'error' | 'partial';
  DATA?: Record<string, any>;  // Structured data if applicable
  METADATA?: {
    lines_affected?: number;
    files_modified?: string[];
    time_ms?: number;
  };
}
```

### Format Function

```typescript
function formatToolResultStructured(
  toolName: string,
  action: string,
  result: string,
  status: 'success' | 'error' | 'partial',
  data?: Record<string, any>,
  metadata?: Record<string, any>
): string {
  // Header
  let output = `TOOL_RESULT:\n`;
  output += `TOOL: ${toolName}\n`;
  output += `ACTION: ${action}\n`;
  output += `STATUS: ${status}\n`;
  
  // Structured data if present
  if (data) {
    output += `DATA:\n`;
    for (const [key, value] of Object.entries(data)) {
      output += `  ${key.toUpperCase()}: ${JSON.stringify(value)}\n`;
    }
  }
  
  // Result summary
  output += `RESULT: ${result}\n`;
  
  // Metadata if present
  if (metadata) {
    output += `METADATA:\n`;
    for (const [key, value] of Object.entries(metadata)) {
      output += `  ${key}: ${value}\n`;
    }
  }
  
  // Delimiter
  output += `---\n`;
  
  return output;
}
```

### Example Output

```
TOOL_RESULT:
TOOL: read_file
ACTION: Read Python file
STATUS: success
DATA:
  FILE: /path/to/main.py
  LINES_READ: 150
  ENCODING: utf-8
RESULT: Successfully read 150 lines from /path/to/main.py
METADATA:
  TIMESTAMP: 2026-04-23T20:45:00Z
---
```

---

## Test Plan

### Day 1-2: Implement Structured Output

1. Create `formatToolResultStructured()` function
2. Add to prompt-builder index.ts
3. Make toggleable: `--structured-output true/false`

### Day 3-4: Benchmark Comparison

```bash
# Compare: standard vs. structured output
python3 benchmark_multi_turn.py --config no-bash --structured-output false --trials 3
python3 benchmark_multi_turn.py --config no-bash --structured-output true --trials 3

# Measure:
# - Task success rate
# - Turn count (should decrease with structured)
# - Token usage (may increase slightly with structure)
# - Multi-step task performance (should improve most)
```

### Day 5: Validate ICL Improvement

Hypothesis: Structured output helps MOST on:
- Multi-step reasoning tasks
- Tasks requiring tool call chains
- Tasks where earlier steps inform later steps

If structured > standard by >5% on multi-step tasks, the ICL catalyst hypothesis is validated.

---

## Alternative: ICL-Stimulating Prompt Format

Beyond tool output, we can also format PROMPTS to stimulate ICL circuits:

### The "Step-Result" Pattern

```
STEP 1: Analyze the problem structure
RESULT: Identified 3 sub-problems

STEP 2: Search for relevant files
RESULT: Found 2 candidate files

STEP 3: Read first file
RESULT: Found import chain

STEP 4: Based on RESULT in STEP 3, determine next action
```

This interleaves derivation with retrieval — the IRCoT insight applied to prompts.

### Implementation

In prompt-builder, for multi-step tasks:

```typescript
function formatPromptWithICLStructure(problem: string, context: any): string {
  return `TASK: ${problem}

REASONING FORMAT:
STEP 1: [action]
RESULT: [observation - what did you learn?]

STEP 2: [based on RESULT in STEP 1, what next?]
RESULT: [what did you learn from this step?]

Continue until solution reached.

TIPS:
- Each STEP should build on the RESULT of the previous
- RESULT should capture the KEY INSIGHT from this step
- Use RESULT to inform the next STEP's action
`;
}
```

---

## Connection to Other Proposals

| Proposal | Connection |
|----------|------------|
| **RepE Prompt Contrast** | Structured output + contrast phrases = full behavioral control |
| **Self-Evolution** | Structured SOPs from successful trajectories |
| **Hierarchical Memory** | Structured memory format catalyzes recall |

---

## Expected Outcome

```
Hypothesis validated if:
  - Structured output > standard on multi-step tasks (>5% improvement)
  - Turn count decreases (better ICL → fewer redundant steps)
  - Effect persists across task types (not just one domain)

Hypothesis rejected if:
  - No significant difference between structured and standard
  - Structured actually hurts (too rigid, constrains reasoning)
```

---

## Status

**Ready to implement** — Waiting on other agent's Tier 1 completion (specifically 1.1: activatePolicyEngine) before integrating into heartbeat.

For now: Implement as standalone option in prompt-builder, test via benchmark.

---

*Related: LATENT-SPACE-EMERGENT-NOVEL-CAPABILITY.md (research foundation)*  
*Related: REPE-PROMPT-CONTRAST-PROPOSAL.md (contrast phrases)*
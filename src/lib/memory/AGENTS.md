# src/lib/memory/ — Memory Engine

The underlying engine behind the memory-related extensions
(`three-memory-stores`, `memory-agent-bridge`, `session-recall`).

This directory was previously named `lib/cognitive-memory/`. The "cognitive"
prefix was redundant — it's just the memory subsystem, mirrored by the
`extensions/memory/` group.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Public API and type exports. `getCognitiveMemory()` factory. |
| `types.ts` | `Episode`, `CognitiveMemoryEntry`, etc. |
| `constants.ts` | Tunable constants (consolidation interval, max entries, etc.). |
| `storage.ts` | JSON persistence to `~/.pi/agent/braid/memory/`. |
| `utils.ts` | Jaccard similarity, auto-tagging, ID generation. |

## Relationship to other layers

- `lib/memory/` is the **engine** — pure data and logic.
- `extensions/memory/three-memory-stores/` is the **agent-facing tool wrapper** — exposes `memory_recall`, `memory_list`, `memory_get`, `memory_store` etc. as LLM-callable tools.
- `lib/store/` is for **ad-hoc persistent claims** (verifier output, conflict resolution). Different from the structured three-store memory.

## Local Contracts

- The three stores are: episodic, semantic, procedural. (See `three-memory-stores` extension for the runtime contract.)
- Memory is **per-session** (resets on session start) AND **persistent** (saved to disk).
- Reads should be fast (sub-100ms). Writes can be slow.

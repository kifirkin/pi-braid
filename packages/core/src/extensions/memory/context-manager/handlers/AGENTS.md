<!-- status: current -->

# src/extensions/memory/context-manager/handlers/ - Compaction & Tool Handlers

The context-manager extension is decomposed into 6 handler modules + 3
sub-tool definitions. The `tools.ts` orchestrator was inlined into
`index.ts` (see commit f131fcb0).

## What "handlers" means here

In this directory, "handlers" = "all the extension's logic, except
the extension factory." Includes:

- Event handlers (`compaction.ts`, `compaction-retry.ts`, `events.ts`,
  `navigation.ts`, `rotation.ts`)
- Shared utilities (`shared.ts`)
- Sub-tool definitions (`tools/<tool>.ts`)

This is a slightly different "handlers" than the other `handlers/`
directories in the codebase. See the AGENTS.md of those for the
distinction.

## Files

| File                        | Purpose                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `shared.ts`                 | State, helpers, retry logic, navigation primitives. 400L.                                             |
| `tool-batch-boundary.ts`    | Tool-batch-safe boundary snapping (`snapBoundaryOutsideToolBatch`) shared by every boundary supplier. |
| `compaction.ts`             | Compaction events + retry + smart instructions. 619L.                                                 |
| `compaction-retry.ts`       | Failure routing (threshold/overflow/summary-cap) + turn-end retry reset. 381L.                        |
| `compaction-chunked.ts`     | Bounded chunked summarization (range archives, summary-cap recovery).                                 |
| `events.ts`                 | agent_end API-error guidance, context pruning. 367L.                                                  |
| `navigation.ts`             | Tree navigation + checkout. 98L.                                                                      |
| `rotation.ts`               | Session rotation + shutdown. 363L.                                                                    |
| `tools/context-compress.ts` | The `context_compress` tool (registers in index.ts).                                                  |
| `tools/context-inspect.ts`  | The `context_inspect` tool.                                                                           |
| `tools/context-navigate.ts` | The `context_navigate` tool.                                                                          |

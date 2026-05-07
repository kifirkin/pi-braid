# Extension: codebase-graph

**Type**: Tool  
**Status**: ✅ Active  
**Module**: `tools`

Analyzes TypeScript/JS dependency graphs within a codebase. Extracts import relationships, detects structural issues (dead code, orphans, circular deps), and predicts change impact.

## What It Does

- **Parses** ES6 import/export statements from TypeScript and JavaScript files
- **Builds** a directed dependency graph (nodes = files, edges = imports)
- **Detects**: dead ends, orphans, hubs, circular dependencies
- **Impact analysis**: given a file, shows what breaks if you change/remove it

## Usage

```typescript
// Basic: full graph summary
await tool("codebase_graph", { path: "/project" });

// Find specific patterns
await tool("codebase_graph", { find: "cycles" });
await tool("codebase_graph", { find: "dead-ends" });
await tool("codebase_graph", { find: "hubs" });
await tool("codebase_graph", { find: "orphans" });

// Impact analysis: what breaks if I change this file?
await tool("codebase_graph", { impact: "src/core/agent.ts" });

// Scope to specific patterns
await tool("codebase_graph", {
  include: ["**/*.ts"],
  exclude: ["**/*.d.ts", "**/*.test.ts"],
});
```

## Parameters

| Param     | Type                                            | Description                   |
| --------- | ----------------------------------------------- | ----------------------------- |
| `path`    | `string?`                                       | Root directory (default: cwd) |
| `find`    | `dead-ends \| orphans \| hubs \| cycles \| all` | What to find                  |
| `impact`  | `string?`                                       | File path for impact analysis |
| `include` | `string[]?`                                     | Include glob patterns         |
| `exclude` | `string[]?`                                     | Exclude glob patterns         |

## Output

- **Summary mode**: files, edges, external deps, dead ends, orphans, hubs, circular deps
- **Find mode**: filtered list of matching files with metadata
- **Impact mode**: risk level, direct dependents, transitive impact count

## Examples

### Find circular dependencies

```
# Circular deps: extension A imports B, B imports A
↻ index.ts → cli.ts → index.ts
↻ memory.ts → store.ts → cache.ts → memory.ts
```

### Impact analysis

```
# Changing src/core/agent.ts affects:
Risk: 🔴 HIGH
Direct dependents: 12 files
Total transitive impact: 47 files
```

## See Also

- `codebase-tree` — Directory structure visualization
- `grep` — Search file contents
- `find` — Locate files by name

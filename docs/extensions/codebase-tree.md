# Extension: codebase-tree

**Status**: ✅ Working
**Tests**: None
**Version**: v0.10.x

## Purpose

Fast directory tree visualization for agents. The `codebase_tree` tool shows directory structure with file stats (size, lines, type), intelligent truncation of large directories (node_modules, .git, dist, etc.), and depth-limited traversal.

## Architecture

Async recursive traversal with gitignore-aware filtering. Large directories (node_modules, .git, dist, etc.) are auto-truncated — shown as `[dir/ 142 items]` without expanding contents. Can be overridden by requesting them as root.

## Events Handled

None — the tool is called directly by the agent.

## Tools

| Tool            | Description                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codebase_tree` | Directory tree visualization. Params: `path` (root dir), `maxDepth` (1-10), `exclude` (glob patterns), `include` (only show matching), `showStats` (file sizes/lines), `compact` (single-line) |

## Key Patterns

- **Root path protection**: Root path (the explicit request target) is never truncated — full contents shown for whatever the agent asked for.
- **Smart truncation**: 15+ directories auto-truncated including `.git`, `node_modules`, `dist`, `build`, `__pycache__`, `.next`, etc. Truncation shows total item count so agent knows whether to dig deeper.
- **Fast for large codebases**: Gitignore-aware (`parseGitignore`) to avoid exploring irrelevant directories. Async I/O via `fs/promises`.
- **Tree rendering**: Uses tree-drawing characters (├── └── │) for visual hierarchy. Color coding with cyan for dirs, magenta for symlinks.

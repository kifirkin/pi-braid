---
name: code-refactoring
description: "Use when restructure/move/rename files or symbols across a TypeScript codebase. Covers ast-grep (sg) import path rewrites, file moves, symbol renames, and multi-file batch updates. Always use sg for structural changes over sed/regex."
---

# Code Refactoring

Move files, rename symbols, and update imports at scale using **ast-grep** (`sg` 0.41.0+) and the TypeScript compiler.

---

## Tool Selection

| Task | Tool | Why |
|------|------|-----|
| Rename symbol (all files) | `sg run -p --rewrite --update-all` | AST-aware, scope-safe |
| Update import paths after file move | `sg run -p --rewrite --update-all` | Precise string matching on import/export statements |
| Find all importers of a file | `rg "from.*'./path'"` | Fast text search, handles all relative patterns |
| Move file to new directory | `mkdir -p dst && mv src/file.ts dst/` then rewire imports | Simple, then fix refs |
| Bulk text replacement across files | Node.js script (REAMDE-driven) | When sg pattern can't express the change |
| Verify no stale refs | `rg "old-path" src/` after move | |

---

## Standard Workflow

1. **Move the file(s)** — `mkdir -p dst && mv src/foo.ts dst/foo.ts`
2. **Fix internal lib references** — files that import from new location with `./` or `../` paths (these don't use `lib/` in path)
3. **Fix external references** — files in extensions/ that import via `lib/old-path`
4. **Verify** — `npx tsc --noEmit`
5. **Test** — `npm test`

---

## Common Patterns

### Pattern A: Move a lib file to a subdirectory

```bash
# 1. Move
mkdir -p src/lib/subdir
mv src/lib/foo.ts src/lib/subdir/

# 2. Fix lib-internal imports (./foo → ./subdir/foo)
#    These use relative paths like "./braid-paths.js"
#    Use rg with literal pattern to find them:
rg "from \"\\./(foo|bar)\"" src/lib/

# 3. Fix extension imports (lib/foo → lib/subdir/foo)
#    These use paths like "../../lib/foo.js"
rg "lib/foo" src/extensions/

# 4. Verify + test
npx tsc --noEmit && npm test
```

### Pattern B: Rename a symbol across all files

```bash
sg run -p 'oldName($$$)' -r 'newName($$$)' --update-all src/
sg run -p 'oldName' -r 'newName' --update-all src/ --data-type=string || true
```

### Pattern C: Update imports after file rename

```bash
# AST-aware: match exact import string
sg run -p "'../lib/old-name.js'" -r "'../lib/new-name.js'" src/ --update-all
```

### Pattern D: Batch edit across many files (when sg can't express the change)

Create a temporary script:

```mjs
import { readFileSync, writeFileSync } from "fs";
const files = ["a.ts", "b.ts"];
for (const f of files) {
  let c = readFileSync(f, "utf-8");
  c = c.replace(/old/g, "new");
  writeFileSync(f, c);
}
```

**Always clean up temp scripts after use.**

---

## Import Path Convention

lib-internal files use relative paths:

| Depth | Pattern |
|-------|---------|
| Same dir | `"./foo.js"` |
| Parent dir | `"../foo.js"` |
| Sibling subdir | `"./subdir/foo.js"` |

Extension files use multi-level relative paths:

| Depth | Pattern |
|-------|---------|
| `contrib/*/` | `"../../lib/foo.js"` |
| `extensions/*/` | `"../../lib/foo.js"` or `"../../../lib/foo.js"` |
| `extensions/*/handlers/` | `"../../../lib/foo.js"` |

---

## Verification

Before considering any refactor complete:

```bash
npx tsc --noEmit   # must be clean
npm test           # zero regressions in passing tests
rg "old-path" src/ # no stale references
```

---

## Limitations

- ast-grep matches AST nodes, not arbitrary text — multiline imports need careful patterns
- For `import { X, Y } from "./path"`, match the entire string, not broken across lines
- ts-mcp-server (MCP) is not supported by pi — use sg + scripts instead
- `sg run --update-all` applies changes without confirmation — always `npx tsc --noEmit` after

---
name: code-search
description: "Use when searching code, refactoring, running codemods, or choosing between search tools. Covers ast-grep vs ripgrep selection and usage patterns."
---

# Code Search

Search the codebase for patterns, run refactors, and choose the right tool for each task.

---

## Tool Selection

| Task | Tool | Why |
|------|------|-----|
| Structural pattern (function call, import, specific syntax) | ast-grep | Understands AST, precise matching |
| Text search across files | ripgrep | Fast, handles large repos |
| File discovery | find | Glob patterns, path-based |
| Rename symbol safely | lang tool (tsc --rename) or ast-grep | Preserves scope |

Most searches → ripgrep. ast-grep for structural patterns.

---

## ast-grep

For structural patterns — function calls, specific imports, exact syntax:

```bash
# Find all calls to a function
npx ast-grep scan --pattern 'func_name($A, $B)' .

# Find calls to specific functions
npx ast-grep scan --pattern 'logger.info($MSG)' .

# Refactor: replace pattern
npx ast-grep run --config <rules-file> --rewrite '$A.then($B)' --where 'kind satisfies "CallExpression"' .
```

---

## ripgrep

For text search across files:

```bash
# Basic search
rg "pattern" .

# Case-insensitive
rg -i "pattern" .

# Just filenames
rg -l "pattern" .

# With context (3 lines before/after)
rg -C 3 "pattern" .

# Replace in place
rg -l "old" . | xargs sed -i '' 's/old/new/g'
```

---

## Refactoring Workflow

1. **Search first** — understand the scope and all usage sites
2. **Preview** — run with --dry-run or just display changes before modifying
3. **Execute** — apply changes
4. **Verify** — run tests or re-search to confirm correct transformation

---

## Common Patterns

### Find a function's callers
```bash
rg "function_name\(" . --type-add 'typescript:*.ts' -t typescript
```

### Find all imports of a module
```bash
rg "^import .* from 'module-name'" .
```

### Rename across files (safety first)
```bash
# Dry run: see all occurrences
rg -l "old_name" . | head -20
# Then replace
rg -l "old_name" . | xargs sed -i '' 's/old_name/new_name/g'
```

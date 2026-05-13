# pi-braid Tool Coverage Proposal

## Goal

Replace `bash` with a set of safe, specific tools that provide 100% of the capabilities an agent needs for coding tasks, while enforcing security guardrails at the tool level.

**Why remove bash?**

1. **Security**: bash can execute arbitrary code, making prompt injection attacks catastrophic
2. **Compliance theater**: Agents fall back to `echo '...' > file` when edit fails, corrupting files
3. **Observability**: Built-in tools give structured logging, bash is opaque
4. **Consistency**: Each tool has predictable behavior, bash has shell-specific quirks

---

## Tool Taxonomy

### Category 1: File Operations (replace `bash: cat, cp, mv, rm, mkdir, chmod`)

| Tool          | Purpose                  | Safety Benefit                                           |
| ------------- | ------------------------ | -------------------------------------------------------- |
| `read`        | Read file contents       | Already built-in, read-only                              |
| `write`       | Create/overwrite files   | Already built-in, atomic write                           |
| `edit`        | Find/replace in files    | Already built-in, surgical change                        |
| `delete`      | Remove files/directories | **NEW**: Confirm with pattern, no glob bypass            |
| `move`        | Rename/move files        | **NEW**: Atomic move with backup                         |
| `copy`        | Copy files/directories   | **NEW**: Recursive copy with exclude patterns            |
| `mkdir`       | Create directories       | **NEW**: Create with parents, sets permissions           |
| `permissions` | chmod/chown files        | **NEW**: Explicit mode strings only (no `-R` by default) |

### Category 2: Code Execution (replace `bash: node, python, ./script`)

| Tool   | Purpose               | Safety Benefit                                                            |
| ------ | --------------------- | ------------------------------------------------------------------------- |
| `repl` | Execute JS/TS code    | Already in pi-braid, sandboxed, timeout, persistent state                 |
| `run`  | Run scripts with args | **NEW**: Explicit interpreter + args, no shell interpolation              |
| `test` | Run test files        | **NEW**: Detect test framework (jest/vitest/node:test), structured output |

### Category 3: Search & Discovery (replace `bash: grep, find, ls`)

| Tool     | Purpose                  | Safety Benefit                             |
| -------- | ------------------------ | ------------------------------------------ |
| `grep`   | Search file contents     | Already built-in, read-only                |
| `find`   | Find files by pattern    | Already built-in, restricted depth         |
| `ls`     | List directory           | Already built-in, can be read-only mode    |
| `tree`   | Directory tree view      | **NEW**: Breadth-limited, exclude patterns |
| `locate` | Fast file search (index) | **NEW**: Uses index, not filesystem scan   |

### Category 4: Code Analysis (NEW capabilities)

| Tool                 | Purpose                   | Safety Benefit                            |
| -------------------- | ------------------------- | ----------------------------------------- |
| `analyze_imports`    | Show imports/dependencies | Safe analysis, no modification            |
| `analyze_size`       | Show file sizes           | Read-only metric                          |
| `analyze_complexity` | Code complexity metrics   | Safe analysis                             |
| `diff`               | Show file differences     | Read-only, supports git or diff two files |
| `git_log`            | Git history               | Safe, limited output                      |
| `git_blame`          | Line attribution          | Safe, optional limit                      |

### Category 5: System & Info (replace `bash: pwd, echo, date, env`)

| Tool          | Purpose                    | Safety Benefit                   |
| ------------- | -------------------------- | -------------------------------- |
| `pwd`         | Working directory          | Read-only                        |
| `echo`        | Print message to console   | Structured output, no subprocess |
| `env`         | List environment variables | Filtered, no sensitive values    |
| `date`        | Current time               | Read-only                        |
| `system_info` | OS/platform info           | Read-only                        |

---

## Proposed New Tool Implementations

### 1. `delete` Tool

```typescript
const deleteSchema = Type.Object({
  path: Type.String({ description: "File or directory to delete" }),
  confirm: Type.Optional(
    Type.Boolean({
      description: "Require explicit confirmation (default: true)",
      default: true,
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description: "Allow deleting directories recursively",
      default: false,
    }),
  ),
  pattern: Type.Optional(
    Type.String({
      description: "Delete files matching glob pattern (e.g., '*.log')",
    }),
  ),
  dry_run: Type.Optional(
    Type.Boolean({
      description: "Show what would be deleted without deleting",
    }),
  ),
});

execute: async (toolCallId, params) => {
  // Security: No shell execution, no pipe/redirection
  // Pattern only works within specified directory
  // No ../ allowed in path
  // Confirmation blocks accidental deletion
};
```

### 2. `run` Tool

```typescript
const runSchema = Type.Object({
  command: Type.String({ description: "Command to run (no shell features)" }),
  args: Type.Array(Type.String(), { description: "Arguments (no shell interpolation)" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeout_ms: Type.Number({ default: 30000 }),
  capture_stdout: Type.Boolean({ default: true }),
  capture_stderr: Type.Boolean({ default: true }),
});

// Security:
// - No shell interpretation (no $VAR, no |, no &&, no ;)
// - Explicit args array only
// - Allowed commands whitelist (node, python, npm, git, etc.)
// - No arbitrary binary execution
```

### 3. `test` Tool

```typescript
const testSchema = Type.Object({
  path: Type.String({ description: "Test file or directory to run" }),
  framework: Type.Optional(
    StringEnum(["auto", "jest", "vitest", "node:test"], {
      default: "auto",
    }),
  ),
  filter: Type.Optional(Type.String({ description: "Filter tests by pattern" })),
  timeout_ms: Type.Number({ default: 60000 }),
});

// Security:
// - Runs only test files, not arbitrary code
// - Structured output (JSON)
// - No arbitrary code execution
// - Kill on timeout
```

### 4. `tree` Tool

```typescript
const treeSchema = Type.Object({
  path: Type.String({ description: "Root directory", default: "." }),
  depth: Type.Number({ description: "Max depth", default: 3 }),
  exclude: Type.Optional(
    Type.Array(Type.String(), {
      description: "Patterns to exclude (node_modules, .git, etc.)",
    }),
  ),
  show_hidden: Type.Boolean({ default: false }),
});

// Security:
// - Bounded depth prevents runaway traversal
// - Exclude patterns prevent accessing .git, credentials, etc.
```

---

## Security Guardrails

### Tool Level

1. **Path Restrictions**
   - No `..` traversal in tool arguments
   - Sandboxed to project directory
   - Configurable allowed paths

2. **Command Whitelisting** (for `run`)

   ```
   ALLOWED_COMMANDS: ["node", "npm", "git", "python", "pip", "cargo"]
   DENIED_COMMANDS: ["rm", "dd", ":(){ :|:& };:", "curl", "wget"]
   ```

3. **Input Validation**
   - All paths validated against allowed patterns
   - No null bytes, no control characters
   - File size limits for read/write

4. **Rate Limiting**
   - Per-tool call limits
   - Burst limits per minute
   - Automatic cooldown on abuse

### Extension Level (enforcement)

5. **Prompt Injection Detection** (prompt-guardian)
   - Detects attempts to override tool behavior
   - Blocks attempts to add new tools
   - Sanitizes system prompt injection

6. **Behavioral Analysis** (enforcement)
   - Monitors for repeated bash-like patterns
   - Warns when agent tries to use unavailable tools
   - Tracks "compliance theater" indicators

---

## Implementation Priority

### Phase 1: Essential (MVP for no-bash)

1. ✅ `read`, `edit`, `write` — already built-in
2. ✅ `repl` — already in pi-braid
3. ⏳ `run` — wrap node/python safely
4. ⏳ `delete` — safe deletion with confirm
5. ⏳ `mkdir` — directory creation
6. ⏳ `move`, `copy` — file operations

### Phase 2: Enhanced

1. ⏳ `test` — test runner integration
2. ⏳ `tree` — directory visualization
3. ⏳ `diff`, `git_log` — version control tools
4. ⏳ `locate` — fast file search

### Phase 3: Advanced

1. ⏳ `analyze_complexity` — code quality
2. ⏳ `analyze_imports` — dependency analysis
3. ⏳ `permissions` — fine-grained access control

---

## Benchmark Results

### Simple Coding Tasks (benchmark_multi_turn.py)

| Tool Set                       | Pass Rate    | Time/task |
| ------------------------------ | ------------ | --------- |
| `read,edit,write,grep,find,ls` | 100% (30/30) | 6-8s      |
| `read,bash,edit,write`         | 100% (30/30) | 6-8s      |
| `braid-full`                   | 90% (27/30)  | 10-20s    |

**Conclusion**: Simple algorithmic tasks show NO significant difference between tool sets. The model can solve them equally well with or without bash.

### Bug Fix Tasks (benchmark_single_fix.py, 3 trials)

| Tool Set      | Pass Rate   |
| ------------- | ----------- |
| no-bash       | 92% (11/12) |
| baseline-bash | 92% (11/12) |
| braid-full    | 75% (9/12)  |

### Code Block Extraction Issue

**Critical observation**: 10-33% of failures are `no-code` — the model doesn't return code in a code block despite explicit instruction. This is NOT a tool issue:

- The model has attention/instruction-following problems
- Adding bash doesn't improve this
- This suggests training issues rather than tool limitations

---

## Migration Path

1. **Phase 1**: Baseline benchmarks with and without bash (DONE)
2. **Phase 2**: Add `run`, `test`, `mkdir` tools (needed for real file ops)
3. **Phase 3**: Enforcement extension warns on bash usage
4. **Phase 4**: Optional bash mode vs locked-down safe mode
5. **Phase 5**: Full removal for high-security environments

---

## References

- pi-braid: `/Users/kifir/projects/agents/pi-braid/`
- pi-poorman-providers: `/Users/kifir/projects/agents/pi-poorman-providers/`
- Benchmarks: `evaluation/benchmark_multi_turn.py`, `evaluation/benchmark_single_fix.py`
- Results: `evaluation/runs/`

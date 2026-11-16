<!-- status: current -->

# bash-cwd - the shell's working directory across calls

Registers a `bash` tool under pi-core's own tool name, so pi's built-in shell
tool is replaced by one that carries a per-session working directory. The shell,
the timeout, the output accumulator, the offload and the renderers are still
pi's: the override delegates to `createBashToolDefinition` with a `spawnHook`
that pins the directory, and only appends one `[cwd ...]` line to the result's
model-facing text.

## Files

| File             | Owns                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `index.ts`       | The tool definition, the per-session state bucket, the delegation, the result note.                         |
| `session-cwd.ts` | The rules: the command scan, the trailing-`cd` parse, the directory resolution, the note's wording. No I/O. |

`session-cwd.ts` is pure and is driven by both the fixture and the corpus
replay, so the state machine the measurement scores is the one the tool runs.

## What does NOT belong here

- **Nothing about process execution.** No `spawn`, no shell resolution, no
  output handling, no truncation, no offload path. If pi's shell tool needs a
  different behaviour, the seam is pi-core's `BashOperations` interface <!-- doc-ref-exempt: pi-core's interface, not a braid symbol -->
  or its definition options, not a second implementation here.
- **No prompt text asking callers to use absolute paths or to `cd` less.** The
  state is the mechanism; a prompt sentence would be a second, advisory copy of
  it. `prompt-builder` owns the `bash` row in `TOOL_GUIDELINES` (it is a pinned
  builtin override there), and that row describes the tool, it does not instruct
  the caller to keep directory state.
- **No cross-session persistence.** The state is `getExtensionState(ctx,
"bash-cwd", …)`: a session's directory dies with the session, and a session
  that pi moves to another cwd (`rebase`) starts over rather than carrying a
  path from a tree it left.
- **No rewriting of commands.** A command is executed exactly as written. The
  persisted directory only decides where it starts; a `cd` the parser could not
  stand behind is still the caller's `cd`, which runs.

## The parse is the safety boundary

A wrong directory is worse than a missing one, so the parser declines rather
than guesses:

- a `cd` inside a subshell, a command substitution, a pipeline or a background
  job runs in another process, so this session's shell is not in that directory;
- a `cd` inside an `if` / `for` / `while` / `case` body, a function body or a
  `{ }` group may not have run at all;
- a `cd` whose argument the shell would have to expand (`$VAR`, `~`, a glob, an
  escape) no longer names a directory;
- `pushd` / `popd` move the shell by a mechanism the scanner does not model;
- an unterminated quote leaves the rest of the text unreadable.

Quotes, comments and heredoc bodies are text, not commands: a `cd` inside
`git commit -m "… cd …"` or inside a `python3 - <<'PY'` body is not read, and a
pipeline or heredoc that follows the `cd` does not make it unreadable.

A declined parse persists nothing, and the caller's own `cd` still runs, because
a command is never rewritten. The existence check after the parse is the second
gate: a target that is not a directory is not persisted, which is what keeps
`cd /a || true` honest when `/a` is missing. The fixture at
`test/runtime/core/test-bash-cwd.mjs` is the population, and it asserts each
acceptance and each refusal.

## Failure modes, named

- **A directory that was removed** falls back to the session start and the
  result says so; the state does not keep a path no process can enter.
- **A failed command moves nothing**, so a `cd` that did not run cannot be
  inherited by the next call.
- **A command whose own `cd` the parser refused** leaves the session where it
  was; the caller's next command may still need its own `cd`.

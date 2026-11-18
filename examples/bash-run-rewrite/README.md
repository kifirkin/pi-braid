<!-- status: current -->

# bash-run rewrite

A pi extension that turns a `bash` call into a `run` call when the command is one program and plain words: no shell syntax to interpret, so the program gets the same arguments without a shell in between. Every other command runs through pi's own bash definition, untouched.

## Why it exists

Most bash calls in a session are a program and its flags: `git status`, `npm run typecheck`, `git log --oneline -3`. A shell interprets none of that, but it is still the thing executing the command, and the harness cannot tell from the call site which calls needed it. The `run` tool exists for exactly this shape: it takes an argv list, refuses the operators that would have made the call a shell program, and reports both streams and a required timeout. What it cannot do is make a caller pick it. This extension makes the choice where the call is decided, so a call written for bash still lands here.

The seam is the tool registry, not a hook. pi hands a `tool_call` handler the argument object and executes the tool name it already resolved; a handler can block, never redirect, and a blocked call's result is an error. A tool registered under a built-in name replaces that definition, which is the one place that can change which tool runs. The core `bash-cwd` extension uses the same seam for the same reason.

## Install

Project-scoped, beside the project's other local extensions:

```bash
cp -r examples/bash-run-rewrite <project>/.pi/extensions/bash-run-rewrite
```

Or point pi at the file from `settings.json`:

```jsonc
{ "extensions": ["file:/absolute/path/to/examples/bash-run-rewrite/index.ts"] }
```

The `package.json` beside the entry declares the module type, so node reads the TypeScript entry as ESM rather than reparsing it. It carries no `pi.extensions` field, which is what keeps pi's discovery on the `index.ts` path.

Copied this way, the extension imports `typebox` and `@earendil-works/pi-coding-agent` at runtime, so the target project needs both resolvable from where it loads. In this repository they resolve from the root `node_modules`.

## What converts, and what stays

A command converts when all of these hold:

| Condition                                 | Example that converts              | Example that stays bash                      |
| ----------------------------------------- | ---------------------------------- | -------------------------------------------- |
| One program, then words                   | `git status`                       | `git status \| wc -l`                        |
| Words separated by a single space         | `npm run test:unit`                | `git  status`, `git status `                 |
| Every character in `A-Za-z0-9._/:@+,%=%-` | `git log --pretty=format:%H`       | `ls *.md`, `cd $(pwd)`, `ls $HOME`           |
| No quoting or escaping                    | `sed -n 1p package.json`           | `git commit -m "a b"`, `ls dir\ with\ space` |
| No leading `NAME=value`                   | `git status`                       | `FOO=1 git status`                           |
| The program is not a shell word           | `ls`, `node`, `rg`                 | `cd`, `echo`, `pwd`, `test`, `if`, `bash`    |
| The program is an executable file         | `git status`, `./scripts/run`      | `not-on-this-machine --help`, `./missing`    |
| The timeout has a whole-millisecond form  | `npm run build` with `timeout: 60` | `npm run build` with `timeout: 0.0005`       |

The whitelist is the whole of the argument. A character outside it has a meaning to bash (quoting, expansion, globbing, redirection, an operator, a test, a comment, brace or tilde expansion), so the command is left to the shell. The words that stay bash are shell builtins, reserved words and shell names: `run` execs `argv[0]`, and none of those is a program. The first word also has to be an executable file - a bare name resolved on `PATH`, a word carrying `/` resolved against the call's directory - because a name that resolves to nothing fails differently on each path: bash prints `command not found` and exits 127, `run` reports a spawn error. The caller learns the same thing either way, and the call keeps the shell's diagnosis.

Two conditions the pure function cannot see also keep the call in bash: the `run` tool has to be reachable from the call, and a call with nowhere to run is the shell's problem, not the converter's.

A call's own `timeout` is carried over: bash takes seconds, `run` takes whole milliseconds, and the conversion is the one pi's bash applies itself (`timeout * 1000`). A call with no timeout gets 120000 ms, because `run` has no unbounded mode. A timeout that has no whole-millisecond form (a fraction under a millisecond, or a value past `setTimeout`'s ceiling) keeps the shell, which then reports it the way bash would.

A program that reads stdin gets end-of-file on both paths: pi runs the shell with stdin ignored, and `run` closes an empty stdin.

## What it records

The first rewrite of a session appends one custom entry holding the line, and every rewrite appends an entry with the running count, so a session file carries one line and a counter. A call that stays bash appends one entry naming the class that kept it there, never the command, so a census can say which shell features keep work in the shell without carrying what the commands said:

```jsonc
{
  "type": "custom",
  "customType": "bash-run-rewrite",
  "data": { "rewrites": 1, "notice": "bash-run rewrite: a plain command executes as run" },
}
{ "type": "custom", "customType": "bash-run-rewrite", "data": { "rewrites": 2 } }
{ "type": "custom", "customType": "bash-run-rewrite", "data": { "refused": "character", "character": "|" } }
{ "type": "custom", "customType": "bash-run-rewrite", "data": { "refused": "builtin" } }
```

The classes are `empty`, `whitespace`, `character` (with the character), `assignment`, `builtin`, `timeout`, `not-a-program`, `not-on-path`, and `no-run-tool` for a session where the `run` tool was not reachable. Custom entries stay out of the model's context; the operator sees the line once per session through `ctx.ui.notify`. The count is the number of conversions that executed the `run` path, not the number of candidates.

## Where the two paths differ

The argv, the program, the working directory and the exit status are the same. What is not identical, and cannot be made identical from inside the call:

- **The timeout.** A call that names one keeps it exactly. A call that names none is bounded at 120000 ms, where bash would have let it run until it finished; a caller that wants no bound at all has to say so, and the shell is where it says it.
- **The environment's PATH.** pi's bash definition prepends pi's own bin directory to `PATH`; `run` uses the caller's environment. The rewrite resolves the program on the caller's `PATH`, so a program that exists only in pi's bin directory keeps the shell.
- **The shell's own layer.** `BASH_ENV`, an exported function or an alias can shadow a program name or change word splitting. A converted call has no shell, so it sees the program on `PATH`, not the shell's version of that name. The same rule covers a shell builtin whose name is also a file: those words are refused rather than resolved. <!-- doc-ref-exempt: BASH_ENV is a bash environment variable, not a symbol in this repository -->
- **A file with no shebang, named by path.** The shell falls back to interpreting it; `run`'s spawn reports the format error on platforms whose spawn does not do that fallback.
- **Output rendering.** Each tool applies its own cap and names the file holding the full text. A converted call returns `run`'s result, so its `details` are the run tool's shape, not bash's.

## Coexistence

This extension replaces `bash` wholesale. Two replacements of the same tool cannot both run: whichever registers last wins, and the other's behavior is gone. In a project that already replaces `bash` (braid's `bash-cwd` is one), the conversion belongs inside that definition rather than beside it, so one tool keeps both behaviors.

## Test

```bash
npm run build -w packages/core                                        # the cross-check reads dist
node packages/core/test/runtime/examples/test-bash-run-rewrite.mjs    # the fixture
node packages/core/test/runtime/examples/test-bash-run-rewrite.mjs --control-arm
```

The fixture registers the extension into a stand-in `pi`, takes the tool definition it registered, and calls `execute()` with the parameters and context the tool would receive; the shell path and `ctx.executeTool` are injected stand-ins, so a case reads what reached each tool without spawning a process. It holds 15 cases: 8 plain commands (each also handed to bash itself for its word list), 39 blocking features, the `PATH` and path-shaped-word rules, the timeout conversion, the count and the refusal classes, and the control. The `--control-arm` form applies the same assertions to the arm with no rewriter registered, and must fail: that failure is what proves the assertions can tell the two arms apart.

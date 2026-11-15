/**
 * Fixture: `run` executes one program with its argv, and refuses every shape
 * that would have required a shell.
 *
 * The contract the fixture pins:
 *   - execution: exit code and both streams come back exactly, stdin closes,
 *     the timeout is mandatory and kills, no TTY is attached, and a glob is not
 *     expanded;
 *   - refusals happen before a process starts, and the message names the
 *     element and the rule (metacharacter, shell command string, glob, missing
 *     timeout, destructive verb leaving the workspace, missing cwd);
 *   - no shell: `$(...)` in an argument is refused, and the same text on stdin
 *     reaches the program literally, so the sentinel is never created;
 *   - bounded output: a stream past the cap keeps its head and tail, reports the
 *     dropped bytes, and the full text is on disk at the named path.
 *
 * The workspace guard is exercised directly too: a symlink inside the
 * workspace that points outside is an escape, while a destructive verb with a
 * path inside the workspace runs.
 *
 * Run: node test/runtime/core/test-run-tool.mjs
 * (built first: npm run build; this fixture reads dist, not src)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The canonical spelling: pwd and realpath report /private/var on macOS where
// mkdtemp hands back /var, and the guard compares canonical paths.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "run-tool-fixture-")));
process.env.BRAID_HOME = join(ROOT, "braid-home");

const { createRunTool } = await import(
  "../../../dist/extensions/core/run-tool/index.js"
);
const { findRefusal, executeArgv, isGlobExpression, DESTRUCTIVE_VERBS } =
  await import("../../../dist/extensions/core/run-tool/run.js");
const { findWorkspaceEscape, pathCandidates, isBelow } = await import(
  "../../../dist/lib/tools/workspace-guard.js"
);

const tool = createRunTool();

let seq = 0;

/** A fresh workspace, plus the context the handler reads. */
function workspace(name) {
  const dir = join(ROOT, `${name}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  const ctx = {
    cwd: dir,
    sessionManager: {
      getSessionId: () => "run-tool-fixture",
      getSessionFile: () => undefined,
    },
  };
  return { dir, ctx };
}

/** Drive the tool the way pi does, with the handler's own argument shape. */
async function call(params, ctx) {
  return tool.execute("call-run-fixture", params, undefined, undefined, ctx);
}

/** The text blocks of a result, joined. */
function textOf(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** A node one-liner with no shell metacharacter: newlines separate statements. */
function nodeCode(code) {
  return ["node", "-e", code];
}

describe("run: execution", () => {
  it("returns stdout and stderr separately, with the exit code", async () => {
    const { ctx } = workspace("streams");
    const result = await call(
      {
        argv: nodeCode(
          'process.stdout.write("out")\nprocess.stderr.write("err")',
        ),
        timeout_ms: 10_000,
      },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.exit_code, 0);
    assert.equal(result.details.stdout.bytes, 3);
    assert.equal(result.details.stderr.bytes, 3);
    const text = textOf(result);
    assert.match(text, /^exit 0 · \d+ms/);
    assert.match(text, /stdout:\nout/);
    assert.match(text, /stderr:\nerr/);
  });

  it("passes a non-zero exit code through and marks the result an error", async () => {
    const { ctx } = workspace("exit");
    const result = await call(
      { argv: nodeCode("process.exit(3)"), timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.exit_code, 3);
    assert.match(textOf(result), /^exit 3 · \d+ms/);
  });

  it("writes the caller's stdin and closes it", async () => {
    const { ctx } = workspace("stdin");
    const result = await call(
      { argv: ["cat"], stdin: "hello\n", timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.stdout.bytes, 6);
    assert.match(textOf(result), /stdout:\nhello\n/);
  });

  it("has no TTY: isTTY is undefined inside the program", async () => {
    const { ctx } = workspace("tty");
    const result = await call(
      {
        argv: nodeCode("process.stdout.write(String(process.stdout.isTTY))"),
        timeout_ms: 10_000,
      },
      ctx,
    );
    assert.equal(result.details.stdout.bytes, 9);
    assert.match(textOf(result), /stdout:\nundefined/);
  });

  it("does not expand a glob", async () => {
    const { dir, ctx } = workspace("glob-pass");
    writeFileSync(join(dir, "aXb"), "content\n");
    const result = await call(
      { argv: ["printf", "%s\\n", "a*b"], timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.match(textOf(result), /stdout:\na\*b\n/);
  });

  it("keeps argument boundaries: spaces and quotes arrive inside one element", async () => {
    const { ctx } = workspace("argv-boundaries");
    const result = await call(
      {
        argv: ["printf", "%s,", "a b", 'c"d', "e"],
        timeout_ms: 10_000,
      },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.match(textOf(result), /stdout:\na b,c"d,e,/);
  });

  it("runs in the session cwd by default and in an explicit cwd when given", async () => {
    const { dir, ctx } = workspace("cwd");
    mkdirSync(join(dir, "sub"));
    const plain = await call({ argv: ["pwd"], timeout_ms: 10_000 }, ctx);
    assert.equal(plain.details.cwd, dir);
    assert.match(textOf(plain), new RegExp(`stdout:\\n${dir}\\n`));
    const explicit = await call(
      { argv: ["pwd"], cwd: "sub", timeout_ms: 10_000 },
      ctx,
    );
    assert.match(textOf(explicit), new RegExp(`stdout:\\n${join(dir, "sub")}\\n`));
  });

  it("merges env over the session environment", async () => {
    const { ctx } = workspace("env");
    const result = await call(
      {
        argv: nodeCode(
          'process.stdout.write(process.env.RUN_FIXTURE ?? "unset")',
        ),
        env: { RUN_FIXTURE: "yes" },
        timeout_ms: 10_000,
      },
      ctx,
    );
    assert.match(textOf(result), /stdout:\nyes/);
  });

  it("kills a program that outlives timeout_ms and says so", async () => {
    const { ctx } = workspace("timeout");
    const startedAt = Date.now();
    const result = await call(
      {
        argv: nodeCode("setTimeout(() => undefined, 60000)"),
        timeout_ms: 300,
      },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.timed_out, true);
    assert.match(textOf(result), /timed out after 300ms: killed/);
    assert.ok(Date.now() - startedAt < 10_000, "the call returned promptly");
  });

  it("states a missing cwd instead of throwing", async () => {
    const { ctx } = workspace("missing-cwd");
    const result = await call(
      { argv: ["pwd"], cwd: "not-there", timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.refused, "cwd");
    assert.match(textOf(result), /does not exist/);
  });

  it("reports a program that cannot be spawned, with no invented exit code", async () => {
    const { ctx } = workspace("missing-program");
    const result = await call(
      { argv: ["definitely-not-a-program-xyz"], timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.exit_code, null);
    assert.match(String(result.details.spawn_error), /ENOENT/);
    assert.match(textOf(result), /could not start definitely-not-a-program-xyz/);
  });

  it("bounds a stream, keeps head and tail, and writes the full text to disk", async () => {
    const { ctx } = workspace("truncate");
    const result = await call(
      {
        argv: nodeCode('process.stdout.write("x".repeat(200000))'),
        max_output_bytes: 1024,
        timeout_ms: 10_000,
      },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.stdout.bytes, 200_000);
    assert.equal(result.details.stdout.truncated, true);
    assert.ok(result.details.stdout.dropped_bytes > 190_000);
    assert.match(textOf(result), /bytes omitted/);
    const path = result.details.stdout.full_text_path;
    assert.ok(path, "the full text path is named");
    assert.equal(readFileSync(path, "utf8").length, 200_000);
    assert.equal(result.details.stderr.truncated, false);
    assert.equal(result.details.stderr.full_text_path, undefined);
  });
});

describe("run: refusals (each fixture reddens when its rule is removed)", () => {
  it("refuses each shell operator, naming it and the element", async () => {
    const { ctx } = workspace("metachar");
    for (const operator of ["|", "&&", ";", "`", "$("]) {
      const result = await call(
        { argv: ["echo", `a${operator}b`], timeout_ms: 10_000 },
        ctx,
      );
      assert.equal(result.isError, true, operator);
      assert.equal(result.details.refused, "metacharacter", operator);
      assert.ok(
        textOf(result).includes(`"${operator}"`),
        `the message names ${operator}`,
      );
      assert.ok(textOf(result).includes("never through a shell"));
    }
  });

  it("refuses a shell asked to run a command string", async () => {
    const { ctx } = workspace("shell-string");
    const result = await call(
      { argv: ["sh", "-c", "echo hi"], timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.refused, "shell-string");
    assert.match(textOf(result), /command string/);
  });

  it("refuses a glob-shaped path argument and points at find and grep", async () => {
    const { ctx } = workspace("glob-refusal");
    const result = await call(
      { argv: ["ls", "*.md"], timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.refused, "glob");
    assert.match(textOf(result), /does not expand globs/);
    assert.match(textOf(result), /find or grep/);
  });

  it("refuses a missing timeout, because no call may hang a session", async () => {
    const { ctx } = workspace("no-timeout");
    const result = await call({ argv: ["pwd"] }, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.refused, "timeout");
    assert.match(textOf(result), /timeout_ms is required/);
  });

  it("refuses an empty argv and a blank element", async () => {
    const { ctx } = workspace("argv-shape");
    const empty = await call({ argv: [], timeout_ms: 1_000 }, ctx);
    assert.equal(empty.details.refused, "argv");
    const blank = await call({ argv: ["echo", ""], timeout_ms: 1_000 }, ctx);
    assert.equal(blank.details.refused, "argv");
  });

  it("refuses a destructive verb naming a path above the workspace", async () => {
    const { dir, ctx } = workspace("escape");
    const outside = join(ROOT, `outside-${seq++}.txt`);
    writeFileSync(outside, "keep\n");
    for (const argv of [
      ["rm", "../" + outside.split("/").pop()],
      ["rm", outside],
      ["mv", outside, "here.txt"],
      ["dd", `of=${outside}`],
      ["chmod", "644", outside],
      ["shred", outside],
      ["truncate", "-s", "0", outside],
    ]) {
      const result = await call({ argv, timeout_ms: 10_000 }, ctx);
      assert.equal(result.isError, true, argv.join(" "));
      assert.equal(result.details.refused, "destructive-escape", argv.join(" "));
      assert.ok(existsSync(outside), "the target was never touched");
    }
    assert.ok(dir);
  });

  it("runs a destructive verb whose path stays inside the workspace", async () => {
    const { dir, ctx } = workspace("inside");
    writeFileSync(join(dir, "gone.txt"), "x\n");
    const result = await call(
      { argv: ["rm", "gone.txt"], timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.equal(existsSync(join(dir, "gone.txt")), false);
  });
});

describe("run: no shell", () => {
  it("never executes $(...) in an argument, and the sentinel is absent", async () => {
    const { ctx } = workspace("substitution");
    const sentinel = join(ROOT, `sentinel-${seq++}.txt`);
    const result = await call(
      {
        argv: ["echo", `$(touch ${sentinel})`],
        timeout_ms: 10_000,
      },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.refused, "metacharacter");
    assert.equal(existsSync(sentinel), false);
  });

  it("passes $(...) on stdin literally, so no shell interprets it", async () => {
    const { ctx } = workspace("stdin-substitution");
    const sentinel = join(ROOT, `sentinel-${seq++}.txt`);
    const result = await call(
      { argv: ["cat"], stdin: `$(touch ${sentinel})\n`, timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.match(textOf(result), /stdout:\n\$\(touch /);
    assert.equal(existsSync(sentinel), false);
  });

  it("spawns with shell: false written out", () => {
    const compiled = readFileSync(
      new URL(
        "../../../dist/extensions/core/run-tool/run.js",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(compiled, /shell: false/);
    assert.equal(/shell: true/.test(compiled), false);
  });
});

describe("workspace guard", () => {
  it("catches a symlink inside the workspace that points outside it", () => {
    const root = join(ROOT, "guard-root");
    const outside = join(ROOT, "guard-outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "link"));
    const escape = findWorkspaceEscape({
      verbs: DESTRUCTIVE_VERBS,
      argv: ["rm", "link"],
      cwd: root,
      workspaceRoot: root,
    });
    assert.ok(escape);
    assert.equal(escape.resolved, outside);
  });

  it("treats the workspace root itself as an escape", () => {
    const root = join(ROOT, "guard-self");
    mkdirSync(root, { recursive: true });
    const escape = findWorkspaceEscape({
      verbs: DESTRUCTIVE_VERBS,
      argv: ["rm", "."],
      cwd: root,
      workspaceRoot: root,
    });
    assert.ok(escape);
    assert.equal(isBelow(root, root), false);
  });

  it("reads path candidates positionally and from key=value", () => {
    assert.deepEqual(pathCandidates(["dd", "if=/a", "of=/b", "bs=1M", "-f"]), [
      { argument: "if=/a", path: "/a" },
      { argument: "of=/b", path: "/b" },
      { argument: "bs=1M", path: "1M" },
    ]);
  });

  it("leaves a non-destructive program alone", () => {
    const root = join(ROOT, "guard-pass");
    mkdirSync(root, { recursive: true });
    assert.equal(
      findWorkspaceEscape({
        verbs: DESTRUCTIVE_VERBS,
        argv: ["cat", "/etc/hosts"],
        cwd: root,
        workspaceRoot: root,
      }),
      null,
    );
  });
});

describe("run: request surface", () => {
  it("declares the tool name and requires timeout_ms in the schema", () => {
    assert.equal(tool.name, "run");
    assert.ok(tool.parameters.required.includes("argv"));
    assert.ok(tool.parameters.required.includes("timeout_ms"));
  });

  it("treats only a star at a path-segment boundary as a glob", () => {
    for (const glob of ["*", "*.md", "src/*", "a/*/b", "build-*"]) {
      assert.equal(isGlobExpression(glob), true, glob);
    }
    for (const pattern of ["--include=*.ts", "s/a.*/x/", "a*b"]) {
      assert.equal(isGlobExpression(pattern), false, pattern);
    }
  });

  it("executes the same request through the core that the handler calls", async () => {
    const { ctx } = workspace("core");
    const refusal = findRefusal(
      { argv: ["pwd"], timeout_ms: 10_000 },
      { cwd: ctx.cwd, workspaceRoot: ctx.cwd },
    );
    assert.equal(refusal, null);
    const capture = await executeArgv(
      { argv: ["printf", "%s", "ok"], timeout_ms: 10_000 },
      { cwd: ctx.cwd, workspaceRoot: ctx.cwd },
    );
    assert.equal(capture.exitCode, 0);
    assert.equal(readFileSync(capture.stdoutPath, "utf8"), "ok");
  });
});

/**
 * Fixture: the `bash` tool's working directory survives the call.
 *
 * The contract this pins, each case quoting the directory a real shell printed:
 *
 *   1. a passing `cd` persists into the next call;
 *   2. a failing `cd` moves nothing;
 *   3. an explicit `cwd` decides that call and leaves the inherited directory alone;
 *   4. a relative `cd` resolves against the directory the call ran in, not the
 *      session start (both targets exist, so a wrong resolution would succeed
 *      and print the wrong path rather than fail);
 *   5. a persisted directory that was removed falls back to the session start;
 *   6. the control, both ways: the identical two-call sequence through pi's own
 *      definition leaves each call at the session start, while the tool under
 *      test carries the directory. The pair is what makes the assertion able to
 *      fail; an arm that only ever ran against the wrapper would pass with no
 *      persistence at all.
 *
 * A `cwd` that names no directory is the argument's own failure, so it is
 * pinned separately: a null, a blank string and the spellings a constrained
 * generator emits when it means either (`"null"`, `"undefined"`) run the call
 * in the directory it would have inherited and leave the note saying so, while
 * a `cwd` naming a file is answered in one line, naming the argument and the
 * path it resolved to, without reaching the shell.
 *
 * The parser's refusals are asserted separately: every shape where the text no
 * longer says where the shell ended up (subshell, pipeline, heredoc, control
 * body, expansion, quoted text that looks like a `cd`) parses to nothing, and
 * the one shape that must not be missed (a `cd` inside `git commit -m "…"`) is
 * quoted text, not a command.
 *
 * Run: node test/runtime/core/test-bash-cwd.mjs
 * (built first: npm run build; this fixture reads dist, not src)
 */

import { after, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mkdtemp hands back /var on macOS while the shell prints /private/var: the
// fixture compares canonical paths, so it starts from one.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "bash-cwd-fixture-")));

const { createBashCwdTool } = await import("../../../dist/extensions/core/bash-cwd/index.js");
const { parseTrailingCd, resolveCdTarget, cwdNote } = await import(
  "../../../dist/extensions/core/bash-cwd/session-cwd.js"
);
const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
const { default: bashCwdExtension } = await import(
  "../../../dist/extensions/core/bash-cwd/index.js"
);

const tool = createBashCwdTool();

let seq = 0;

/** A fresh session directory, plus the context the handler reads. */
function session(name) {
  const dir = join(ROOT, `${name}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  const sessionId = `bash-cwd-fixture-${dir}`;
  const ctx = {
    cwd: dir,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
    },
  };
  return { dir, ctx };
}

/** Drive the tool the way pi does. */
async function call(ctx, params) {
  return tool.execute("call-bash-cwd-fixture", params, undefined, undefined, ctx);
}

/** The model-facing text of a result. */
function textOf(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** What a `pwd` call printed: the directory the shell actually ran in. */
function printedDir(result) {
  return textOf(result).split("\n")[0].trim();
}

/** The `[cwd ...]` line a result carries, or undefined. */
function cwdLine(result) {
  return /\[cwd [^\]]*\]/.exec(textOf(result))?.[0];
}

after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bash: the working directory carries across calls", () => {
  it("persists a passing cd: the next call runs where the first one ended", async () => {
    const { dir, ctx } = session("persist");
    const sub = join(dir, "sub");
    mkdirSync(sub);

    const first = await call(ctx, { command: `cd ${sub} && pwd` });
    assert.equal(printedDir(first), sub, "the first call runs where its own cd went");

    const second = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(second), sub, "the second call inherits the first call's directory");
    assert.equal(cwdLine(second), `[cwd ${sub}]`);
  });

  it("persists a trailing cd inside a longer command", async () => {
    const { dir, ctx } = session("trailing");
    const sub = join(dir, "later");
    mkdirSync(sub);

    await call(ctx, { command: `pwd && cd ${sub} && pwd` });
    const next = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(next), sub);
  });

  it("a failed command moves nothing", async () => {
    const { dir, ctx } = session("failed");
    const sub = join(dir, "sub");
    mkdirSync(sub);

    const failed = await call(ctx, { command: `cd ${sub} && false` });
    assert.equal(failed.isError, true, "the call itself fails");

    const next = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(next), dir, "a cd in a failed command did not move the session");
  });

  it("a failing cd moves nothing", async () => {
    const { dir, ctx } = session("missing");
    mkdirSync(join(dir, "sub"));

    const failed = await call(ctx, { command: `cd ${join(dir, "absent")} && pwd` });
    assert.equal(failed.isError, true);

    const next = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(next), dir);
  });

  it("an explicit cwd decides that call and leaves the inherited directory alone", async () => {
    const { dir, ctx } = session("explicit");
    const sub = join(dir, "sub");
    const other = join(dir, "other");
    mkdirSync(sub);
    mkdirSync(other);

    await call(ctx, { command: `cd ${sub} && pwd` });

    const overridden = await call(ctx, { command: "pwd", cwd: other });
    assert.equal(printedDir(overridden), other, "the explicit cwd is where the call runs");
    assert.equal(
      cwdLine(overridden),
      `[cwd ${other}; the next call inherits ${sub}]`,
      "the result states both directories, so the override is not mistaken for a move",
    );

    const next = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(next), sub, "the override did not change what the next call inherits");
  });

  it("a relative cwd resolves against the directory the call would have inherited", async () => {
    const { dir, ctx } = session("relative-cwd");
    const sub = join(dir, "sub");
    const inner = join(sub, "inner");
    mkdirSync(inner, { recursive: true });
    // The same relative name exists under the session start, so a cwd resolved
    // there would succeed and print the other path instead of failing.
    mkdirSync(join(dir, "inner"));

    await call(ctx, { command: `cd ${sub} && pwd` });

    const overridden = await call(ctx, { command: "pwd", cwd: "inner" });
    assert.equal(printedDir(overridden), inner, "relative to the directory the session is in");
    assert.notEqual(printedDir(overridden), join(dir, "inner"));

    const next = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(next), sub, "the override did not change what the next call inherits");
  });

  it("a relative cd resolves against the directory the call ran in", async () => {
    const { dir, ctx } = session("relative");
    const sub = join(dir, "sub");
    const inner = join(sub, "inner");
    mkdirSync(inner, { recursive: true });
    // The same relative name exists under the session start, so a cd resolved
    // there would succeed and print the other path instead of failing.
    mkdirSync(join(dir, "inner"));

    const leading = await call(ctx, { command: "cd sub && pwd" });
    assert.equal(printedDir(leading), sub);

    const relative = await call(ctx, { command: "cd inner && pwd" });
    assert.equal(printedDir(relative), inner, "relative to the directory the call ran in");
    assert.notEqual(printedDir(relative), join(dir, "inner"));

    const next = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(next), inner);
  });

  it("a persisted directory that was removed falls back to the session start", async () => {
    const { dir, ctx } = session("removed");
    const sub = join(dir, "sub");
    mkdirSync(sub);

    await call(ctx, { command: `cd ${sub} && pwd` });
    rmSync(sub, { recursive: true, force: true });

    const next = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(next), dir);
    assert.equal(cwdLine(next), `[cwd ${dir} (the previous directory no longer exists)]`);
  });

  it("the same sequence through pi's own definition starts each call at the session start", async () => {
    const { dir, ctx } = session("control");
    const sub = join(dir, "sub");
    mkdirSync(sub);

    // The control arm: pi's definition, unwrapped, driven exactly like the tool
    // under test. This is the behaviour the assertion above can distinguish.
    const plain = createBashToolDefinition(dir);
    const plainFirst = await plain.execute(
      "call-control-1",
      { command: `cd ${sub} && pwd` },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(printedDir(plainFirst), sub, "the first call's own cd still works");

    const plainSecond = await plain.execute(
      "call-control-2",
      { command: "pwd" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(printedDir(plainSecond), dir, "unwrapped, the second call starts over");

    // The two arms differ only in the wrapper, so the wrapper is what carries
    // the directory.
    const wrappedFirst = await call(ctx, { command: `cd ${sub} && pwd` });
    assert.equal(printedDir(wrappedFirst), sub);
    const wrappedSecond = await call(ctx, { command: "pwd" });
    assert.equal(printedDir(wrappedSecond), sub);
    assert.notEqual(printedDir(wrappedSecond), printedDir(plainSecond));
  });

  it("keeps pi's own arguments and adds cwd", () => {
    const base = createBashToolDefinition(ROOT).parameters;
    const ours = tool.parameters;
    const added = Object.keys(ours.properties).filter((key) => !(key in base.properties));
    assert.deepEqual(added, ["cwd"], "the override adds one argument and no others");
    for (const key of Object.keys(base.properties)) {
      assert.deepEqual(ours.properties[key], base.properties[key], `\`${key}\` is pi's own`);
    }
  });

  it("admits a null cwd, so a provider that sends one is validated rather than stringified", () => {
    const cwd = tool.parameters.properties.cwd;
    const branches = Array.isArray(cwd.anyOf)
      ? cwd.anyOf
      : Array.isArray(cwd.type)
        ? cwd.type.map((type) => ({ type }))
        : [];
    const types = branches.map((branch) => branch.type);
    assert.ok(types.includes("null"), `the schema names null among ${JSON.stringify(types)}`);
    assert.ok(types.includes("string"), "and a string beside it");
  });
});

describe("bash: a cwd that names no directory", () => {
  /** A session already sitting in `sub`, so the inherited directory and the start directory differ. */
  async function parkedInSub(name) {
    const { dir, ctx } = session(name);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    await call(ctx, { command: `cd ${sub} && pwd` });
    return { ctx, sub };
  }

  it("cwd: null runs in the inherited directory and is not reported as an override", async () => {
    const { ctx, sub } = await parkedInSub("cwd-null");
    const result = await call(ctx, { command: "pwd", cwd: null });
    assert.equal(printedDir(result), sub, "the call runs where it would have run without a cwd");
    assert.equal(
      cwdLine(result),
      `[cwd ${sub}]`,
      "the note names the session directory, not a one-call override",
    );
    assert.ok(!result.isError, "nothing failed");
  });

  for (const value of ["null", "undefined", "NULL", "", "   "]) {
    it(`cwd: ${JSON.stringify(value)} is absent, not an override`, async () => {
      const { ctx, sub } = await parkedInSub("cwd-absent");
      const result = await call(ctx, { command: "pwd", cwd: value });
      assert.equal(printedDir(result), sub);
      assert.equal(cwdLine(result), `[cwd ${sub}]`);
      assert.ok(!result.isError);
    });
  }

  it("a directory named after one of those words is still reachable as a path", async () => {
    const { dir, ctx } = session("cwd-word-directory");
    const word = join(dir, "null");
    mkdirSync(word);

    // The rule reads the bare word, not the path: `./null` names the directory.
    const result = await call(ctx, { command: "pwd", cwd: "./null" });
    assert.equal(printedDir(result), word);
  });

  it("cwd naming a file answers one line and never reaches the shell", async () => {
    const { dir, ctx } = session("cwd-file");
    const file = join(dir, "notes.txt");
    writeFileSync(file, "not a directory\n");
    const marker = join(dir, "reached-shell");

    // A relative argument, so the answer has to carry two different texts: the
    // argument as written and the path it resolved to.
    const result = await call(ctx, { command: `touch ${marker}`, cwd: "notes.txt" });

    assert.equal(result.isError, true, "the call failed");
    const lines = textOf(result)
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.equal(lines.length, 1, `one line, got ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes(JSON.stringify("notes.txt")), `names the argument: ${lines[0]}`);
    assert.ok(lines[0].includes(file), `names the resolved path: ${lines[0]}`);
    assert.equal(existsSync(marker), false, "the command never reached the shell");
  });
});

describe("bash: the extension registers the override", () => {
  it("registers one tool, under pi's own name", () => {
    const tools = [];
    bashCwdExtension({ registerTool: (tool) => tools.push(tool) });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "bash", "the name is pi's, which is what makes it a replacement");
    assert.equal(typeof tools[0].execute, "function");
  });
});

describe("bash: the parser refuses what the text does not settle", () => {
  const accepts = [
    ["cd /a && npm test", "/a"],
    ["cd sub && pwd", "sub"],
    ["pwd && cd /b", "/b"],
    ["cd /a && cd /b", "/b"],
    ["cd /a;cd /b", "/b"],
    ["cd /a\npwd", "/a"],
    ["cd /a 2>/dev/null && pwd", "/a"],
    ["build && cd /a", "/a"],
    ['cd "/a b" && pwd', "/a b"],
    ["cd ../sibling", "../sibling"],
    // A pipeline, a heredoc or a `||` after the cd does not move the cd itself.
    ["cd /a && npx tsc 2>&1 | head -40", "/a"],
    ["cd /a && grep x || true", "/a"],
    ["cd /a || true", "/a"],
    ["cd /a && cat <<'PY'\ncd /nope\nPY", "/a"],
  ];
  for (const [command, path] of accepts) {
    it(`accepts \`${command.replace(/\n/g, "\\n")}\``, () => {
      assert.equal(parseTrailingCd(command)?.path, path);
    });
  }

  const refuses = [
    "cd",
    "cd -",
    "cd --",
    "cd ~",
    "cd ~/x",
    "cd $HOME && pwd",
    "cd /a/*",
    "cd /a y",
    "cd /a | tee out",
    "cd /a &",
    "x=$(cd /a && pwd)",
    "(cd /a && pwd)",
    "cd /a && (cd /b && pwd)",
    "cd /a && f() { cd /b; }",
    "{ cd /a; }",
    "cat <<EOF\ncd /x\nEOF",
    "echo \"x; cd /y\"",
    'git commit -m "x; cd /y"',
    "if [ -d /a ]; then cd /a; fi",
    "for d in /a; do cd $d; done",
    "# cd /a\npwd",
    "cd 'unterminated",
  ];
  for (const command of refuses) {
    it(`refuses \`${command.replace(/\n/g, "\\n")}\``, () => {
      assert.equal(parseTrailingCd(command), undefined);
    });
  }

  it("resolves a parsed cd against the directory the call ran in", () => {
    assert.equal(resolveCdTarget({ path: "inner" }, "/a/b"), "/a/b/inner");
    assert.equal(resolveCdTarget({ path: "../c" }, "/a/b"), "/a/c");
    assert.equal(resolveCdTarget({ path: "/abs" }, "/a/b"), "/abs");
  });
});

describe("bash: the cwd line states what the caller inherits", () => {
  it("says nothing when the call ran at the session start and the session is still there", () => {
    assert.equal(cwdNote({ base: "/a", ranIn: "/a", next: "/a", stale: false, overridden: false }), undefined);
  });

  it("names the directory the next call inherits", () => {
    assert.equal(
      cwdNote({ base: "/a", ranIn: "/a/b", next: "/a/b", stale: false, overridden: false }),
      "[cwd /a/b]",
    );
  });

  it("states both directories when a call moved the session", () => {
    assert.equal(
      cwdNote({ base: "/a", ranIn: "/a", next: "/a/b", stale: false, overridden: false }),
      "[cwd /a -> /a/b]",
    );
  });

  it("marks an override as one call, not a move", () => {
    assert.equal(
      cwdNote({ base: "/a", ranIn: "/c", next: "/a/b", stale: false, overridden: true }),
      "[cwd /c; the next call inherits /a/b]",
    );
  });

  it("says when the persisted directory was gone", () => {
    assert.equal(
      cwdNote({ base: "/a", ranIn: "/a", next: "/a", stale: true, overridden: false }),
      "[cwd /a (the previous directory no longer exists)]",
    );
  });
});

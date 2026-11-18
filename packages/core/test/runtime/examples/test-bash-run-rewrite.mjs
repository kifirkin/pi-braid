/**
 * Fixture: a plain bash command executes as `run`, and everything else stays bash.
 *
 * The extension replaces the `bash` tool definition, so the fixture drives it the
 * way pi does: load the registration into a stand-in `pi`, take the tool
 * definition it registered, and call `execute()` with the parameters and the
 * context the tool would receive. The two things the tool does outside itself
 * are injected: the shell path (pi's bash definition) and `ctx.executeTool`
 * (which runs the `run` tool). A case therefore reads what reached each tool
 * without spawning a process, and the shell stand-in is the same on both arms.
 *
 * Cases:
 * 1. A plain command executes as `run`, with the word list bash would have
 *    passed, the required timeout, and no `cwd` key unless the call carried one.
 * 2. bash itself tokenizes the same text, and the words agree: the converter is
 *    checked against a shell, not against its own idea of a split.
 * 3. `run`'s own refusal read accepts every converted call, and refuses a glob,
 *    so the cross-check is not vacuous.
 * 4. One case per blocking shell feature stays bash, naming the character or
 *    word that kept it there; quoted arguments and a leading assignment are
 *    among them. A first word that is not an executable on this machine stays
 *    bash, and a path-shaped word is resolved against the call's directory.
 * 5. The count is real: three rewrites and two refusals in one session produce
 *    three counted entries and two refusal entries, one notice, and no entry for
 *    a call the converter never saw.
 * 6. Nothing else moves: one tool is registered, no event hook is, and a call
 *    that is not converted reaches the shell with its parameters untouched.
 * 7. Control: with no rewriter registered the same call arrives at bash with its
 *    command unchanged, and nothing is recorded.
 *
 * Run: node packages/core/test/runtime/examples/test-bash-run-rewrite.mjs
 *      node packages/core/test/runtime/examples/test-bash-run-rewrite.mjs --control-arm
 *
 * The second form applies the same green assertions to the arm with no rewriter
 * registered. It must fail: that failure is the control, and it proves the
 * assertions can tell the two arms apart.
 *
 * The cross-check reads `packages/core/dist`, so run `npm run build -w packages/core`
 * first; without it the case fails and names the missing build.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..", "..");
const ENTRY = join(ROOT, "examples", "bash-run-rewrite", "index.ts");
const RUN_TOOL = join(ROOT, "packages", "core", "dist", "extensions", "core", "run-tool", "run.js");

const { default: bashRunRewrite, convert, createBashRunRewriteTool, DEFAULT_TIMEOUT_MS, NOTICE } =
  await import(pathToFileURL(ENTRY).href);

/** Commands that are one program and plain words: every one must convert. */
const PLAIN = [
  "git status",
  "npm run typecheck",
  "git log --oneline -3",
  "node packages/core/scripts/run-tests.mjs --list",
  "git log --pretty=format:%H -1",
  "npm test --workspace packages/core",
  "git commit --amend --no-edit",
  "sed -n 1p package.json",
];

/** Every blocking shell feature, with the rule that has to name it. */
const BLOCKED = [
  ["git status | wc -l", "character", "|"],
  ["npm test && npm run lint", "character", "&"],
  ["npm test || npm run lint", "character", "|"],
  ["echo done; ls", "character", ";"],
  ["npm test &", "character", "&"],
  ["git log > out.txt", "character", ">"],
  ["wc -l < file", "character", "<"],
  ["cd $(pwd)", "character", "$"],
  ["ls `pwd`", "character", "`"],
  ["ls $HOME", "character", "$"],
  ["ls *.md", "character", "*"],
  ["ls file?.md", "character", "?"],
  ["ls ~/projects", "character", "~"],
  ["ls {a,b}.md", "character", "{"],
  ["(cd packages/core && ls)", "character", "("],
  ["ls file[0].md", "character", "["],
  ["ls # note", "character", "#"],
  ["npm test !", "character", "!"],
  ["ls dir\\ with\\ space", "character", "\\"],
  ['git commit -m "a b"', "character", '"'],
  ["git commit -m 'a b'", "character", "'"],
  ["git status\tcpu", "whitespace", "tab or newline"],
  ["git status\nls", "whitespace", "tab or newline"],
  ["git  status", "whitespace", "space"],
  [" git status", "whitespace", "space"],
  ["git status ", "whitespace", "space"],
  ["FOO=1 git status", "assignment", "FOO=1"],
  ["FOO=1", "assignment", "FOO=1"],
  ["cd packages/core", "builtin", "cd"],
  ["echo hello", "builtin", "echo"],
  ["export FOO=1", "builtin", "export"],
  ["source .venv/bin/activate", "builtin", "source"],
  ["pwd", "builtin", "pwd"],
  ["if true", "builtin", "if"],
  ["bash -c ls", "builtin", "bash"],
  ["sh scripts/release.sh", "builtin", "sh"],
  ["-n ls", "not-a-program", "-n"],
  ["not-a-program-this-machine-lacks --help", "not-on-path", "not-a-program-this-machine-lacks"],
  ["", "empty", undefined],
];

/** Whether this run applies the green assertions to the control arm. */
const CONTROL_ARM = process.argv.includes("--control-arm");

/** A stand-in pi: it records what an extension registers and what it writes. */
function standInPi() {
  const tools = new Map();
  const entries = [];
  const hooks = [];
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name) {
      hooks.push({ kind: "command", name });
    },
    on(event, handler) {
      hooks.push({ kind: "event", event, handler });
      return () => {};
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
  return { pi, tools, entries, hooks };
}

/** The shell path as a spy: it answers with the command it was handed. */
function shellResult(params) {
  return { content: [{ type: "text", text: `bash: ${params.command}` }], details: undefined };
}

/**
 * One session: its registered `bash` tool, the context that tool receives, and
 * the calls that reached each side. `sessionManager` is one object per session,
 * because the counter is keyed on it.
 */
function openSession({ rewrite = !CONTROL_ARM, runAvailable = true } = {}) {
  const { pi, tools, entries, hooks } = standInPi();
  const shellCalls = [];
  const runCalls = [];
  const notices = [];
  const sessionManager = {};
  const shell = async (_toolCallId, params) => {
    shellCalls.push(params);
    return shellResult(params);
  };

  if (rewrite) {
    pi.registerTool(
      createBashRunRewriteTool({
        shell,
        appendEntry: (customType, data) => pi.appendEntry(customType, data),
        fallbackCwd: ROOT,
      }),
    );
  } else {
    tools.set("bash", {
      name: "bash",
      label: "bash",
      description: "pi's bash, as the fixture stands it in",
      parameters: undefined,
      async execute(_toolCallId, params) {
        shellCalls.push(params);
        return shellResult(params);
      },
    });
  }

  const ctx = {
    cwd: ROOT,
    sessionManager,
    ui: { notify: (text, level) => notices.push({ text, level }) },
    tools: runAvailable ? [{ name: "bash" }, { name: "run" }] : [{ name: "bash" }],
    async executeTool(name, args) {
      runCalls.push({ name, args });
      return {
        toolCall: { id: `${name}-nested`, name, arguments: args },
        result: { content: [{ type: "text", text: `run: ${args.argv.join(" ")}` }], details: {} },
        isError: false,
      };
    },
  };

  const tool = tools.get("bash");
  async function bash(params) {
    return tool.execute("call-1", params, undefined, undefined, ctx);
  }
  return { tool, bash, hooks, entries, notices, shellCalls, runCalls };
}

/** The words bash hands a program for this text, read from bash itself. */
function bashWords(command) {
  const program = "process.stdout.write(process.argv.slice(1).join(String.fromCharCode(0)))";
  const out = execFileSync("bash", ["-c", `node -e '${program}' ${command}`], { encoding: "utf8" });
  return out.split("\0");
}

/** `run`'s refusal read, from the built tree. */
async function runRefusal() {
  if (!existsSync(RUN_TOOL)) {
    throw new Error(`${RUN_TOOL} is missing: run \`npm run build -w packages/core\` before this fixture`);
  }
  return (await import(pathToFileURL(RUN_TOOL).href)).findRefusal;
}

describe("the extension's surface", () => {
  it("registers one tool under the built-in name, with the bash arguments plus cwd", () => {
    const { pi, tools, hooks } = standInPi();
    bashRunRewrite(pi);

    assert.deepEqual([...tools.keys()], ["bash"]);
    const tool = tools.get("bash");
    assert.equal(tool.label, "bash");
    assert.deepEqual(Object.keys(tool.parameters.properties), ["command", "timeout", "cwd"]);
    assert.deepEqual(tool.parameters.required, ["command"]);
    // No hook: every other tool, and every call this one declines, is reached by
    // pi exactly as it would have been without the extension.
    assert.deepEqual(hooks, []);
  });
});

describe("the rewrite happens", () => {
  it("a plain command executes as run, with the words bash would have passed", async () => {
    const session = openSession();
    const executed = await session.bash({ command: "git status" });

    assert.deepEqual(session.runCalls, [
      { name: "run", args: { argv: ["git", "status"], timeout_ms: DEFAULT_TIMEOUT_MS } },
    ]);
    assert.deepEqual(session.shellCalls, []);
    assert.equal(executed.content[0].text, "run: git status");
  });

  it("a call's cwd is passed through unchanged, and its own timeout carries over", async () => {
    const session = openSession();
    await session.bash({ command: "npm run test:unit", cwd: "packages/core", timeout: 600 });

    assert.deepEqual(session.runCalls[0].args, {
      argv: ["npm", "run", "test:unit"],
      timeout_ms: 600_000,
      cwd: "packages/core",
    });
  });

  it("every plain command converts, and keeps its word order", () => {
    for (const command of PLAIN) {
      const converted = convert(command);
      assert.equal(converted.kind, "run", command);
      assert.deepEqual(converted.argv, command.split(" "), command);
    }
  });

  it("bash hands over exactly the words the rewrite passes", () => {
    for (const command of PLAIN) {
      const converted = convert(command);
      assert.equal(converted.kind, "run", command);
      assert.deepEqual(converted.argv, bashWords(command), command);
    }
  });

  it("run's refusal read accepts every converted call, and refuses a glob", async () => {
    const findRefusal = await runRefusal();
    const context = { cwd: ROOT, workspaceRoot: ROOT };

    for (const command of PLAIN) {
      const converted = convert(command);
      assert.equal(converted.kind, "run", command);
      const request = { argv: converted.argv, timeout_ms: DEFAULT_TIMEOUT_MS };
      assert.equal(findRefusal(request, context), null, command);
    }

    const glob = findRefusal({ argv: ["ls", "*.md"], timeout_ms: DEFAULT_TIMEOUT_MS }, context);
    assert.equal(glob?.kind, "glob");
  });
});

describe("nothing else moves", () => {
  it("one case per blocking shell feature stays bash, and names the rule", () => {
    for (const [command, code, detail] of BLOCKED) {
      const converted = convert(command);
      assert.equal(converted.kind, "bash", JSON.stringify(command));
      assert.equal(converted.refusal.code, code, JSON.stringify(command));
      assert.equal(converted.refusal.detail, detail, JSON.stringify(command));
    }
  });

  it("a timeout run's field cannot hold stays bash", () => {
    const converted = convert("npm run build", { timeout: 0.0005 });
    assert.equal(converted.kind, "bash");
    assert.equal(converted.refusal.code, "timeout");
  });

  it("a path-shaped first word is resolved against the call's directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-run-rewrite-"));
    writeFileSync(join(dir, "runnable"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "runnable"), 0o755);
    writeFileSync(join(dir, "plain.txt"), "x\n");

    assert.equal(convert("./runnable", { cwd: dir }).kind, "run");
    assert.equal(convert("./missing", { cwd: dir }).refusal.code, "not-on-path");
    assert.equal(convert("./plain.txt", { cwd: dir }).refusal.code, "not-on-path");
    // The same word from another directory is a different program.
    assert.equal(convert("./runnable", { cwd: tmpdir() }).refusal.code, "not-on-path");
  });

  it("a first word that is not on PATH stays bash", () => {
    const converted = convert("not-a-program-this-machine-lacks --help");
    assert.equal(converted.kind, "bash");
    assert.equal(converted.refusal.code, "not-on-path");
  });

  it("a blocked call reaches the shell with its command untouched, and says why", async () => {
    const session = openSession();
    await session.bash({ command: "npm test && npm run lint" });

    assert.deepEqual(session.shellCalls, [{ command: "npm test && npm run lint" }]);
    assert.deepEqual(session.runCalls, []);
    assert.deepEqual(session.entries, [
      { customType: "bash-run-rewrite", data: { refused: "character", character: "&" } },
    ]);
  });

  it("a call the run tool cannot serve says so and stays bash", async () => {
    const session = openSession({ runAvailable: false });
    await session.bash({ command: "git status" });

    assert.deepEqual(session.shellCalls, [{ command: "git status" }]);
    assert.deepEqual(session.runCalls, []);
    assert.deepEqual(session.entries, [
      { customType: "bash-run-rewrite", data: { refused: "no-run-tool" } },
    ]);
  });
});

describe("the count is real", () => {
  it("three rewrites and two refusals leave three counts and two classes", async () => {
    const session = openSession();
    await session.bash({ command: "git status" });
    await session.bash({ command: "npm run typecheck" });
    await session.bash({ command: "ls | wc -l" });
    await session.bash({ command: "sed -n 1p package.json" });
    await session.bash({ command: "FOO=1 git status" });

    const counted = session.entries.filter((entry) => "rewrites" in entry.data);
    const refused = session.entries.filter((entry) => "refused" in entry.data);

    assert.deepEqual(
      counted.map((entry) => entry.data.rewrites),
      [1, 2, 3],
    );
    assert.deepEqual(
      refused.map((entry) => entry.data.refused),
      ["character", "assignment"],
    );
    assert.equal(session.entries.filter((entry) => entry.data.notice === NOTICE).length, 1);
    assert.deepEqual(
      session.notices.map((notice) => notice.text),
      [NOTICE],
    );
    assert.equal(session.runCalls.length, 3);
    assert.equal(session.shellCalls.length, 2);
  });

  it("a new session starts its own line and its own count", async () => {
    const first = openSession();
    await first.bash({ command: "git status" });
    const second = openSession();
    await second.bash({ command: "git status" });

    assert.equal(second.notices.length, 1);
    assert.deepEqual(
      second.entries.map((entry) => entry.data.rewrites),
      [1],
    );
  });
});

describe("the honest control", () => {
  it("with no rewriter registered the command arrives at bash unchanged", async () => {
    const control = openSession({ rewrite: false });
    const executed = await control.bash({ command: "git status" });

    assert.deepEqual(control.shellCalls, [{ command: "git status" }]);
    assert.deepEqual(control.runCalls, []);
    assert.deepEqual(control.entries, []);
    assert.deepEqual(control.notices, []);
    assert.equal(executed.content[0].text, "bash: git status");
  });
});

/**
 * Fixture: the three argv tools beside `run`, each checked against the shell
 * form it replaces.
 *
 * The contract this pins:
 *   - `filter` reproduces `producer | head`, `producer | tail`,
 *     `producer | grep pattern` and `producer | wc -l` on the same producer,
 *     and the one place byte equality cannot hold (the local `wc` pads its
 *     count in its own columns) is asserted as the same integer plus whitespace;
 *   - `sink` writes the same bytes as `producer > out 2> err`, and the counts it
 *     reports are the files' own sizes;
 *   - `feed` passes bytes: a one-megabyte producer stream carrying a lone
 *     carriage return, a NUL and bytes that are not valid UTF-8 arrives at the
 *     consumer with the same digest, and a plain text stream arrives byte for
 *     byte;
 *   - no shell surface: a metacharacter in any argv element is refused before a
 *     program starts, with the stage and the element index named;
 *   - the cap is `run`'s cap: the same constants, the same refusal message, the
 *     same head-and-tail window, and a file holding the full stream;
 *   - the manifest registers all three beside `run-tool`.
 *
 * Run: node test/runtime/core/test-argv-tools.mjs
 * (built first: npm run build; this fixture reads dist, not src)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The canonical spelling: pwd and realpath report /private/var on macOS where
// mkdtemp hands back /var.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "argv-tools-fixture-")));
process.env.BRAID_HOME = join(ROOT, "braid-home");

const { createFilterTool } = await import("../../../dist/extensions/core/filter/index.js");
const { createSinkTool } = await import("../../../dist/extensions/core/sink/index.js");
const { createFeedTool } = await import("../../../dist/extensions/core/feed/index.js");
const { MAX_FEED_BYTES } = await import("../../../dist/extensions/core/feed/feed.js");
const { DEFAULT_LINES, MAX_LINES } = await import(
  "../../../dist/extensions/core/filter/filter.js"
);
const { createRunTool } = await import("../../../dist/extensions/core/run-tool/index.js");
const {
  DEFAULT_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MIN_OUTPUT_BYTES,
} = await import("../../../dist/extensions/core/run-tool/run.js");
const { MANIFEST } = await import("../../../dist/extensions/manifest.js");

const TOOLS = {
  run: createRunTool(),
  filter: createFilterTool(),
  sink: createSinkTool(),
  feed: createFeedTool(),
};

const LINES = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n";

let seq = 0;

/** A fresh workspace, plus the context the handler reads. */
function workspace(name) {
  const dir = join(ROOT, `${name}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  const ctx = {
    cwd: dir,
    sessionManager: {
      getSessionId: () => "argv-tools-fixture",
      getSessionFile: () => undefined,
    },
  };
  return { dir, ctx };
}

/** Drive a tool the way pi does, with the handler's own argument shape. */
async function call(tool, params, ctx) {
  return TOOLS[tool].execute(`call-${tool}-fixture`, params, undefined, undefined, ctx);
}

/** The text blocks of a result, joined. */
function textOf(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** The stdout section of a result, which is where the stream starts. */
function stdoutSection(text) {
  const marker = "stdout:\n";
  const index = text.indexOf(marker);
  assert.notEqual(index, -1, `result carries no stdout section:\n${text}`);
  return text.slice(index + marker.length);
}

/** The same command through a real shell, for the comparison. */
function bash(command, cwd) {
  return execFileSync("/bin/bash", ["-c", command], { cwd });
}

/** A node program as argv, with newlines between statements: no shell needed. */
function nodeProgram(...statements) {
  return ["node", "-e", statements.join("\n")];
}

/** One megabyte, a lone carriage return, a NUL, and bytes UTF-8 cannot carry. */
function binaryPayload() {
  const buffer = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < buffer.length; index++) buffer[index] = (index * 7 + 13) % 256;
  buffer[100] = 13;
  buffer[101] = 0;
  return buffer;
}

/** A consumer that prints the sha256 and length of everything it reads. */
const HASH_CONSUMER = [
  'const c=require("node:crypto")',
  'const h=c.createHash("sha256")',
  "let n=0",
  'process.stdin.on("data",b=>{h.update(b)',
  "n+=b.length})",
  'process.stdin.on("end",()=>{process.stdout.write(h.digest("hex")+" "+n)})',
];

// ── B1: filter reproduces the pipeline ──────────────────────────────────────

describe("filter: the bash form, byte for byte", () => {
  const cases = [
    { name: "head", params: { through: "head", lines: 3 }, shell: "cat lines.txt | head -n 3" },
    { name: "tail", params: { through: "tail", lines: 3 }, shell: "cat lines.txt | tail -n 3" },
    {
      name: "grep",
      params: { through: "grep", pattern: "ta" },
      shell: "cat lines.txt | grep ta",
    },
  ];

  for (const one of cases) {
    it(`${one.name} keeps the same bytes as \`${one.shell}\``, async () => {
      const { dir, ctx } = workspace(`filter-${one.name}`);
      writeFileSync(join(dir, "lines.txt"), LINES);
      const result = await call(
        "filter",
        { argv: ["cat", "lines.txt"], timeout_ms: 10_000, ...one.params },
        ctx,
      );
      assert.equal(result.isError, false, textOf(result));
      const shellBytes = bash(one.shell, dir);
      const mine = Buffer.from(stdoutSection(textOf(result)), "utf8");
      assert.equal(mine.length, shellBytes.length, `bytes differ in length:\n${textOf(result)}`);
      assert.deepEqual(mine, shellBytes);
      assert.equal(result.details.stdout.truncated, false);
    });
  }

  it("wc -l prints the count the shell prints, without the shell's column padding", async () => {
    const { dir, ctx } = workspace("filter-wc");
    writeFileSync(join(dir, "lines.txt"), LINES);
    const result = await call(
      "filter",
      { argv: ["cat", "lines.txt"], timeout_ms: 10_000, through: "wc" },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));
    const shellCount = bash("cat lines.txt | wc -l", dir).toString();
    assert.equal(Number(shellCount.trim()), 10);
    // BSD wc pads a single count to seven columns and GNU wc does not, so the
    // portable claim is the integer; the difference from the shell is whitespace.
    assert.equal(stdoutSection(textOf(result)), "10\n");
    assert.equal(stdoutSection(textOf(result)).trim(), shellCount.trim());
    assert.equal(result.details.lines_kept, 10);
  });

  it("a final line with no newline: the stream matches, the section adds the display newline", async () => {
    const { dir, ctx } = workspace("filter-unterminated");
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc");
    const result = await call(
      "filter",
      { argv: ["cat", "lines.txt"], timeout_ms: 10_000, through: "tail", lines: 2 },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));
    const shellBytes = bash("cat lines.txt | tail -n 2", dir);
    // The stream is the shell's bytes; the section ends the line for display,
    // which is the convention every captured stream in this family follows.
    assert.equal(result.details.stdout.bytes, shellBytes.length);
    assert.equal(stdoutSection(textOf(result)), `${shellBytes.toString("utf8")}\n`);
  });

  it("a producer that fails is an error result carrying its exit code", async () => {
    const { ctx } = workspace("filter-failing-producer");
    const result = await call(
      "filter",
      { argv: nodeProgram("process.stdout.write('half a line\\n')", "process.exit(3)"), timeout_ms: 10_000, through: "head", lines: 5 },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.exit_code, 3);
    assert.equal(stdoutSection(textOf(result)), "half a line\n");
  });
});

// ── B2: sink reproduces the redirect ────────────────────────────────────────

describe("sink: the redirect, byte for byte", () => {
  it("writes both streams to the shell's bytes and reports their sizes", async () => {
    const { dir, ctx } = workspace("sink-both");
    writeFileSync(
      join(dir, "prog.js"),
      "process.stdout.write('stdout-bytes-ü')\nprocess.stderr.write('stderr-bytes')\n",
    );
    bash("node prog.js > shell-out 2> shell-err", dir);
    const result = await call(
      "sink",
      { argv: ["node", "prog.js"], timeout_ms: 10_000, stdout_to: "out", stderr_to: "err" },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));

    const out = readFileSync(join(dir, "out"));
    const err = readFileSync(join(dir, "err"));
    assert.deepEqual(out, readFileSync(join(dir, "shell-out")));
    assert.deepEqual(err, readFileSync(join(dir, "shell-err")));
    assert.equal(result.details.stdout_path, join(dir, "out"));
    assert.equal(result.details.stderr_path, join(dir, "err"));
    assert.equal(result.details.stdout_bytes, statSync(join(dir, "out")).size);
    assert.equal(result.details.stderr_bytes, statSync(join(dir, "err")).size);
    assert.match(textOf(result), /stdout -> .*out \(15 bytes\)/);
    assert.match(textOf(result), /stderr -> .*err \(12 bytes\)/);
  });

  it("shows the stream it did not redirect, and creates the file it did", async () => {
    const { dir, ctx } = workspace("sink-one");
    const result = await call(
      "sink",
      {
        argv: nodeProgram("process.stdout.write('kept')", "process.stderr.write('shown')"),
        timeout_ms: 10_000,
        stdout_to: "out",
      },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));
    assert.equal(readFileSync(join(dir, "out"), "utf8"), "kept");
    assert.equal(result.details.stdout, undefined);
    assert.equal(result.details.stderr.bytes, 5);
    assert.match(textOf(result), /stderr:\nshown/);
  });
});

// ── B3: feed passes bytes ───────────────────────────────────────────────────

describe("feed: bytes, not text", () => {
  it("hands a binary producer stream to the consumer unchanged", async () => {
    const { dir, ctx } = workspace("feed-binary");
    const payload = binaryPayload();
    writeFileSync(join(dir, "in.bin"), payload);
    const result = await call(
      "feed",
      {
        from: ["cat", "in.bin"],
        to: nodeProgram(...HASH_CONSUMER),
        timeout_ms: 30_000,
      },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));
    const digest = createHash("sha256").update(payload).digest("hex");
    // The consumer writes no trailing newline; the renderer adds one to show the
    // stream as a section, so that is the only byte the section carries beyond
    // the stream itself.
    assert.equal(stdoutSection(textOf(result)), `${digest} ${payload.length}\n`);
    assert.equal(result.details.from.exit_code, 0);
    assert.equal(result.details.from.bytes, payload.length);
  });

  it("gives the consumer the producer's stdout with nothing added", async () => {
    const { dir, ctx } = workspace("feed-text");
    const text = "one\ntwo\nthree\n";
    writeFileSync(join(dir, "in.txt"), text);
    const result = await call(
      "feed",
      { from: ["cat", "in.txt"], to: ["cat"], timeout_ms: 10_000 },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));
    assert.equal(stdoutSection(textOf(result)), text);
  });

  it("answers with the consumer's exit and reports the producer's", async () => {
    const { dir, ctx } = workspace("feed-exits");
    writeFileSync(join(dir, "in.txt"), "abc\n");
    const result = await call(
      "feed",
      {
        from: nodeProgram("process.stdout.write('abc\\n')", "process.exit(4)"),
        to: nodeProgram('process.stdin.resume()', "process.stdin.on('end',()=>process.exit(0))"),
        timeout_ms: 10_000,
      },
      ctx,
    );
    assert.equal(result.details.from.exit_code, 4);
    assert.equal(result.details.to.exit_code, 0);
    assert.equal(result.isError, false);
    assert.match(textOf(result), /from: exit 4/);
  });
});

// ── B4: no shell surface ────────────────────────────────────────────────────

const OPERATORS = [
  { label: "pipe", element: "a|b" },
  { label: "and", element: "a&&b" },
  { label: "semicolon", element: "a;b" },
  { label: "backtick", element: "a`b`" },
  { label: "substitution", element: "a$(b)" },
];

describe("no shell surface: every operator, every tool", () => {
  for (const operator of OPERATORS) {
    it(`filter refuses a ${operator.label}`, async () => {
      const { ctx } = workspace(`refuse-filter-${operator.label}`);
      const result = await call(
        "filter",
        { argv: ["true", operator.element], timeout_ms: 10_000, through: "head" },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.ok(textOf(result).includes(operator.element), "the refusal quotes the element");
      assert.match(textOf(result), /refused: argv\[1\] carries "/);
      assert.match(textOf(result), /filter executes argv directly/);
    });

    it(`sink refuses a ${operator.label}`, async () => {
      const { ctx } = workspace(`refuse-sink-${operator.label}`);
      const result = await call(
        "sink",
        { argv: ["true", operator.element], timeout_ms: 10_000, stdout_to: "out" },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.ok(textOf(result).includes(operator.element), "the refusal quotes the element");
      assert.match(textOf(result), /refused: argv\[1\] carries "/);
      assert.match(textOf(result), /sink executes argv directly/);
    });

    it(`feed refuses a ${operator.label} in either stage`, async () => {
      for (const stage of ["from", "to"]) {
        const { ctx } = workspace(`refuse-feed-${operator.label}-${stage}`);
        const result = await call(
          "feed",
          {
            from: stage === "from" ? ["true", operator.element] : ["true"],
            to: stage === "to" ? ["true", operator.element] : ["cat"],
            timeout_ms: 10_000,
          },
          ctx,
        );
        assert.equal(result.isError, true);
        assert.ok(textOf(result).includes(operator.element), "the refusal quotes the element");
        assert.match(textOf(result), new RegExp(`refused: ${stage}\\[1\\] carries "`));
        assert.match(textOf(result), /feed executes argv directly/);
      }
    });
  }

  it("refuses a shell command string rather than running it", async () => {
    const { ctx } = workspace("refuse-shell-string");
    const result = await call(
      "filter",
      { argv: ["bash", "-c", "cat lines.txt"], timeout_ms: 10_000, through: "head" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /is a shell and argv carries -c/);
  });
});

// ── B5: the cap is the existing cap ─────────────────────────────────────────

describe("the cap is run's cap", () => {
  it("filter windows a stream past the cap and keeps the full reduction on disk", async () => {
    const { dir, ctx } = workspace("cap-filter");
    const payload = binaryPayload();
    writeFileSync(join(dir, "big.bin"), payload);
    const result = await call(
      "filter",
      {
        argv: ["cat", "big.bin"],
        timeout_ms: 20_000,
        through: "grep",
        pattern: ".",
        max_output_bytes: MIN_OUTPUT_BYTES,
      },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));
    const stream = result.details.stdout;
    assert.equal(stream.truncated, true);
    assert.equal(stream.bytes, payload.length + 1); // grep terminates the line it prints
    assert.equal(stream.shown_bytes + stream.dropped_bytes, stream.bytes);
    assert.ok(stream.dropped_bytes > 0);
    assert.ok(stream.full_text_path, "the result names the file holding the full stream");
    assert.equal(statSync(stream.full_text_path).size, stream.bytes);
    assert.match(textOf(result), /omitted; full text:/);
  });

  it("feed windows a stream past the cap and keeps the full text on disk", async () => {
    const { dir, ctx } = workspace("cap-feed");
    const payload = binaryPayload();
    writeFileSync(join(dir, "big.bin"), payload);
    const result = await call(
      "feed",
      {
        from: ["cat", "big.bin"],
        to: ["cat"],
        timeout_ms: 30_000,
        max_output_bytes: MIN_OUTPUT_BYTES,
      },
      ctx,
    );
    assert.equal(result.isError, false, textOf(result));
    const stream = result.details.stdout;
    assert.equal(stream.truncated, true);
    assert.equal(stream.bytes, payload.length);
    assert.equal(stream.shown_bytes + stream.dropped_bytes, stream.bytes);
    assert.equal(statSync(stream.full_text_path).size, stream.bytes);
  });

  it("refuses a cap below the minimum with run's own message", async () => {
    const { ctx } = workspace("cap-refusal");
    for (const tooSmall of [MIN_OUTPUT_BYTES - 1, MAX_OUTPUT_BYTES + 1]) {
      const run = await TOOLS.run.execute(
        "call-run-fixture",
        { argv: ["true"], timeout_ms: 10_000, max_output_bytes: tooSmall },
        undefined,
        undefined,
        ctx,
      );
      for (const [tool, params] of [
        ["filter", { argv: ["true"], timeout_ms: 10_000, through: "head" }],
        ["feed", { from: ["true"], to: ["cat"], timeout_ms: 10_000 }],
      ]) {
        const mine = await TOOLS[tool].execute(
          `call-${tool}-fixture`,
          { ...params, max_output_bytes: tooSmall },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(mine.isError, true);
        assert.equal(textOf(mine), textOf(run), `${tool} must refuse with run's message`);
        assert.match(textOf(mine), new RegExp(`from ${MIN_OUTPUT_BYTES} to ${MAX_OUTPUT_BYTES}`));
      }
    }
  });

  it("the defaults are run's defaults", () => {
    assert.equal(DEFAULT_OUTPUT_BYTES, 51_200);
    assert.equal(MIN_OUTPUT_BYTES, 1_024);
    assert.equal(DEFAULT_LINES, 10);
    assert.ok(MAX_LINES >= 1_000);
  });

  it("refuses a producer stream past the in-memory ceiling, naming its size", async () => {
    const { dir, ctx } = workspace("feed-ceiling");
    const oversize = MAX_FEED_BYTES + 1024 * 1024;
    writeFileSync(join(dir, "huge.bin"), Buffer.alloc(oversize, 0x61));
    const result = await call(
      "feed",
      { from: ["cat", "huge.bin"], to: ["cat"], timeout_ms: 60_000 },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), new RegExp(`past the ${MAX_FEED_BYTES}-byte limit`));
    assert.match(textOf(result), new RegExp(`from wrote ${oversize} bytes`));
    assert.equal(result.details.refused, "feed-input");
    assert.equal(result.details.to, undefined);
  });
});

// ── refusals particular to each tool ────────────────────────────────────────

describe("argument refusals before a program starts", () => {
  it("filter refuses a pattern the chosen reduction cannot read", async () => {
    const { ctx } = workspace("filter-pattern-ignored");
    const result = await call(
      "filter",
      { argv: ["true"], timeout_ms: 10_000, through: "head", pattern: "x" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /pattern is only read by through "grep"/);
  });

  it("filter refuses grep without a pattern, and a pattern that does not compile", async () => {
    const { ctx } = workspace("filter-pattern-missing");
    const missing = await call(
      "filter",
      { argv: ["true"], timeout_ms: 10_000, through: "grep" },
      ctx,
    );
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /through "grep" needs a pattern/);
    const broken = await call(
      "filter",
      { argv: ["true"], timeout_ms: 10_000, through: "grep", pattern: "(" },
      ctx,
    );
    assert.equal(broken.isError, true);
    assert.match(textOf(broken), /pattern is not a regular expression/);
  });

  it("filter refuses lines outside its range, and lines on wc", async () => {
    const { ctx } = workspace("filter-lines");
    const over = await call(
      "filter",
      { argv: ["true"], timeout_ms: 10_000, through: "head", lines: MAX_LINES + 1 },
      ctx,
    );
    assert.equal(over.isError, true);
    assert.match(textOf(over), new RegExp(`lines must be an integer from 1 to ${MAX_LINES}`));
    const ignored = await call(
      "filter",
      { argv: ["true"], timeout_ms: 10_000, through: "wc", lines: 2 },
      ctx,
    );
    assert.equal(ignored.isError, true);
    assert.match(textOf(ignored), /lines is only read by through "head" and "tail"/);
  });

  it("sink refuses a call with no destination", async () => {
    const { ctx } = workspace("sink-no-target");
    const result = await call("sink", { argv: ["true"], timeout_ms: 10_000 }, ctx);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /sink needs stdout_to or stderr_to/);
  });

  it("sink refuses two destinations that resolve to one path", async () => {
    const { dir, ctx } = workspace("sink-one-path");
    const result = await call(
      "sink",
      { argv: ["true"], timeout_ms: 10_000, stdout_to: "both.log", stderr_to: "./both.log" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /resolve to the same path/);
    assert.equal(existsSync(join(dir, "both.log")), false, "a refused call writes nothing");
  });

  it("sink refuses a destination whose directory does not exist", async () => {
    const { ctx } = workspace("sink-no-dir");
    const result = await call(
      "sink",
      { argv: ["true"], timeout_ms: 10_000, stdout_to: "missing/out.log" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /does not exist or is not a directory/);
  });

  it("sink refuses a destination that is a directory", async () => {
    const { dir, ctx } = workspace("sink-directory");
    mkdirSync(join(dir, "out"));
    const result = await call(
      "sink",
      { argv: ["true"], timeout_ms: 10_000, stdout_to: "out" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /is a directory; a stream cannot be written to a directory/);
  });
});

// ── B6: the tools arrive where run arrives ──────────────────────────────────

describe("manifest", () => {
  it("registers all three beside run-tool, none of them always-on", () => {
    const ids = MANIFEST.map((entry) => entry.id);
    for (const id of ["filter", "sink", "feed"]) {
      assert.ok(ids.includes(id), `the manifest must name ${id}`);
      const entry = MANIFEST.find((one) => one.id === id);
      assert.equal(typeof entry.fn, "function", `${id} must carry its factory`);
      assert.ok(entry.desc.length > 0, `${id} must carry a description`);
      assert.notEqual(entry.alwaysOn, true, `${id} is not always-on`);
    }
    assert.equal(
      ids.indexOf("filter"),
      ids.indexOf("run-tool") + 1,
      "the argv tools follow run-tool in the manifest",
    );
    assert.equal(ids.indexOf("sink"), ids.indexOf("filter") + 1);
    assert.equal(ids.indexOf("feed"), ids.indexOf("sink") + 1);
  });
});

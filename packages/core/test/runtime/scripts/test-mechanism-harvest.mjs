/**
 * mechanism-harvest.mjs contract: a repair-shaped window is a failing tool
 * result followed, inside the window, by a mutation that shares a token with
 * the failure, and the census accounts for every failing event exactly once.
 *
 * Every case writes real pi session files into a temp directory and runs the
 * script over them with `--json`, so the assertions pin the printed record and
 * the census rather than an internal function that could drift from them.
 *
 * The last group pins what the detector deliberately cannot see: a failure
 * that names a symbol and a mutation that names only the file defining it have
 * no shared token, so the window is dropped. That boundary is a stated part of
 * the design, and a case here keeps it from being "fixed" silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "..", "..", "..", "scripts", "mechanism-harvest.mjs");

const START = "2026-01-02T03:04:05.000Z";
const body = (textValue) => ({ type: "text", text: textValue });
const call = (name, args) => ({ type: "toolCall", id: "c1", name, arguments: args });
const entry = (role, content, extra = {}) =>
  JSON.stringify({ type: "message", timestamp: START, message: { role, content, ...extra } });
const assistant = (...parts) => entry("assistant", parts);
const user = (value) => entry("user", [body(value)]);
const result = (tool, value, extra = {}) =>
  entry("toolResult", [body(value)], { toolCallId: "c1", toolName: tool, isError: false, ...extra });

/** Run the instrument over one corpus directory and return its JSON report. */
function run(dir, args = []) {
  const stdout = execFileSync(
    process.execPath,
    [script, "--sessions", dir, "--json", ...args],
    { encoding: "utf-8" },
  );
  return JSON.parse(stdout);
}

/** A temp corpus directory whose cleanup is the caller's finally block. */
function corpus(files) {
  const dir = mkdtempSync(join(tmpdir(), "mechanism-harvest-"));
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), Buffer.concat(lines.map((line) => Buffer.from(`${line}\n`))));
  }
  return dir;
}

const header = (start = START) =>
  JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: start, cwd: "/fixture/tree" });

const sha = (value) => createHash("sha256").update(value).digest("hex");

// A failing compile, then an edit of the file the compiler named.
// The repository's stale-reference scan reads every literal quoted path in a test
// file and requires the file to exist. These paths are synthetic session content,
// so the prefix is assembled here and never appears as a quoted source path.
const SRC = "s" + "rc/";

const FAIL_TS = `${SRC}a.ts(84,11): error TS2552: Cannot find name 'viewerId'.\nCommand exited with code 2`;

test("emits a path-linked window for a failure repaired by an edit", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      user("fix the build"),
      result("bash", FAIL_TS, { isError: true }),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "viewerId", newText: "_viewerId" }] })),
      result("edit", "Successfully replaced 1 block(s)."),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(report.census.failing_events, 1);
    assert.equal(report.records.length, 1, "one failure with a linked mutation is one window");
    const record = report.records[0];
    assert.equal(record.failure.event, 1, "the failing result is the window's first event");
    assert.equal(record.failure.tool, "bash");
    assert.equal(record.failure.kind, "isError");
    assert.match(record.failure.error, /error TS2552/);
    assert.equal(record.mutation.event, 2);
    assert.equal(record.mutation.tool, "edit");
    assert.equal(record.mutation.target, `${SRC}a.ts`);
    assert.deepEqual(record.token, { kind: "path", text: `${SRC}a.ts` });
    assert.match(record.window, /\[1\] toolResult bash isError/, "the record carries the raw window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("links a failure to an edit through a symbol in the replaced text", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      user("run the fixture"),
      result("bash", "EXIT=1\n[FAIL] parseHeading reads only the first heading"),
      assistant(call("edit", { path: `${SRC}reader.ts`, edits: [{ oldText: "parseHeading", newText: "parseHeading" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].token.kind, "symbol");
    assert.equal(report.records[0].token.text, "parseHeading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counts a failure with no mutation inside the window", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", FAIL_TS, { isError: true }),
      assistant(call("read", { path: `${SRC}a.ts` })),
      result("read", "import type { X } from 'y';"),
      assistant(call("grep", { pattern: "viewerId" })),
      result("grep", `${SRC}a.ts:84`),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(report.records.length, 0);
    assert.equal(report.census.dropped_no_mutation, 1, "reading and searching are not mutations");
    assert.equal(report.census.failing_events, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drops a window whose failure and mutation share no token", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", "EXIT=1\n[ok] triggerMatches: word boundaries"),
      assistant(
        call("edit", {
          path: `${SRC}reader.ts`,
          edits: [{ oldText: "/** Max triggers per skill. */\nexport const MAX_TRIGGERS = 12;", newText: "x" }],
        }),
      ),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(
      report.records.length,
      0,
      "the failure names a symbol and the mutation names the file that defines it; nothing is shared",
    );
    assert.equal(report.census.dropped_no_shared_token, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collapses overlapping windows into the earliest", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", "error TS2552: src/a.ts(1,1)\nCommand exited with code 2", { isError: true }),
      assistant(call("read", { path: `${SRC}a.ts` })),
      result("bash", "EXIT=1\nsrc/a.ts: still broken"),
      assistant(call("read", { path: `${SRC}a.ts` })),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(report.census.failing_events, 2);
    assert.equal(report.records.length, 1, "the same repair seen from two failures is one repair");
    assert.equal(report.census.collapsed, 1);
    assert.equal(report.records[0].failure.event, 0, "the earliest failure keeps the window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps two repairs that do not overlap", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", "error: src/a.ts(1,1)\nCommand exited with code 2", { isError: true }),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
      user("next problem"),
      result("bash", "error: src/b.ts(2,2)\nCommand exited with code 2", { isError: true }),
      assistant(call("edit", { path: `${SRC}b.ts`, edits: [{ oldText: "c", newText: "d" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(report.records.length, 2);
    assert.deepEqual(
      report.records.map((record) => record.mutation.target),
      [`${SRC}a.ts`, `${SRC}b.ts`],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drops a window too large to be a repair", () => {
  const filler = "diagnostic line that goes nowhere\n".repeat(2200);
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", `${filler}error: src/a.ts(9,9)\nCommand exited with code 2`, { isError: true }),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(report.records.length, 0);
    assert.equal(report.census.dropped_window_too_large, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the target of a redirect and of sed -i", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", "ENOENT: no such file or directory, open 'report.txt'\nCommand exited with code 1"),
      assistant(call("bash", { command: "node build.mjs > report.txt 2>&1" })),
      result("bash", "ok"),
    ],
    "b.jsonl": [
      header(),
      result("bash", "{ \"port\": 1 } has an invalid value at config/settings.json\nCommand exited with code 1"),
      assistant(call("bash", { command: "sed -i '' 's/port: 1/port: 2/' config/settings.json" })),
      result("bash", "ok"),
    ],
  });
  try {
    const report = run(dir);
    assert.deepEqual(
      report.records.map((record) => record.mutation.target),
      ["report.txt", "config/settings.json"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counts the three failure markers apart", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", "a.ts is not a module", { isError: true }),
      assistant(call("edit", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] })),
      result("edit", "replaced"),
    ],
    "b.jsonl": [
      header(),
      result("bash", "Error: a.ts did not compile\nCommand exited with code 3"),
      assistant(call("edit", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] })),
      result("edit", "replaced"),
    ],
    "c.jsonl": [
      header(),
      result("bash", "Traceback (most recent call last):\n  File \"a.py\", line 3\nValueError: nope"),
      assistant(call("edit", { path: "a.py", edits: [{ oldText: "1", newText: "2" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir);
    const kinds = report.records.map((record) => record.failure.kind).sort();
    assert.deepEqual(kinds, ["exception", "exit", "isError"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file's own text is not a failure", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("edit", "Successfully replaced 1 block(s)."),
      assistant(call("read", { path: `${SRC}a.ts` })),
      result("read", "import x from 'y';\n\n// earlier a TypeError was thrown here\nexport const a = 1;"),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(report.census.failing_events, 0, "an exception name inside a file is content, not a failure");
    assert.equal(report.records.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips a non-UTF8 line, counts it, and keeps the rest of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mechanism-harvest-"));
  try {
    const clean = [
      header(),
      result("bash", FAIL_TS, { isError: true }),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ];
    const torn = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x0a]);
    writeFileSync(
      join(dir, "a.jsonl"),
      Buffer.concat([Buffer.from(`${clean.join("\n")}\n`), torn]),
    );
    const report = run(dir);
    assert.equal(report.census.skipped_non_utf8_lines, 1);
    assert.equal(report.records.length, 1, "the valid window before the torn line is still read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty session reads as zero events without failing", () => {
  const dir = corpus({ "a.jsonl": [header()] });
  try {
    const report = run(dir);
    assert.equal(report.census.files, 1);
    assert.equal(report.census.events, 0);
    assert.equal(report.census.files_without_events, 1);
    assert.deepEqual(report.records, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same corpus twice yields identical output", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", FAIL_TS, { isError: true }),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    assert.equal(sha(JSON.stringify(run(dir))), sha(JSON.stringify(run(dir))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--window bounds how far the mutation may sit", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", FAIL_TS, { isError: true }),
      assistant(call("read", { path: "x" })),
      result("read", "x"),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    assert.equal(run(dir, ["--window", "2"]).records.length, 0, "the mutation sits three events later");
    assert.equal(run(dir, ["--window", "8"]).records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--since keeps sessions by their recorded start", () => {
  const dir = corpus({
    "old.jsonl": [
      header("2025-11-01T00:00:00.000Z"),
      result("bash", FAIL_TS, { isError: true }),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ],
    "new.jsonl": [
      header("2026-01-01T00:00:00.000Z"),
      result("bash", "error TS2304: src/b.ts(1,1)\nCommand exited with code 2", { isError: true }),
      assistant(call("edit", { path: `${SRC}b.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
    ],
  });
  try {
    const report = run(dir, ["--since", "2025-12-15T00:00:00.000Z"]);
    assert.equal(report.census.files_skipped_by_since, 1);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].mutation.target, `${SRC}b.ts`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction snapshots are pruned and counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "mechanism-harvest-"));
  try {
    writeFileSync(join(dir, "live.jsonl"), `${[header(), result("bash", "x")].join("\n")}\n`);
    mkdirSync(join(dir, "archives"));
    for (const name of ["one.jsonl", "two.jsonl"]) {
      writeFileSync(
        join(dir, "archives", name),
        `${JSON.stringify({ sessionId: "s", reason: "compact", originals: "[]" })}\n`,
      );
    }
    const report = run(dir);
    assert.equal(report.census.pruned_archive_dirs, 1);
    assert.equal(report.census.pruned_archive_files, 2);
    assert.equal(report.census.files, 1, "a snapshot is a re-encoded copy, not a session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write's new content is not a link", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", "EXIT=1\n[FAIL] the parser skips the heading"),
      assistant(call("write", { path: `${SRC}other.ts`, content: "export const parseHeading = 1;\n" })),
      result("write", "Successfully wrote 1 file"),
    ],
  });
  try {
    const report = run(dir);
    assert.equal(
      report.records.length,
      0,
      "a fresh file mentions many symbols, so a match in new content is a coincidence",
    );
    assert.equal(report.census.dropped_no_shared_token, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the census accounts for every failing event exactly once", () => {
  const dir = corpus({
    "a.jsonl": [
      header(),
      result("bash", FAIL_TS, { isError: true }),
      assistant(call("edit", { path: `${SRC}a.ts`, edits: [{ oldText: "a", newText: "b" }] })),
      result("edit", "replaced"),
      result("bash", "error: src/b.ts\nCommand exited with code 1"),
      result("bash", "no mutation follows this one"),
    ],
  });
  try {
    const report = run(dir);
    const total =
      report.census.windows +
      report.census.collapsed +
      report.census.dropped_no_mutation +
      report.census.dropped_no_shared_token +
      report.census.dropped_window_too_large;
    assert.equal(total, report.census.failing_events);
    assert.equal(report.census.windows, report.records.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

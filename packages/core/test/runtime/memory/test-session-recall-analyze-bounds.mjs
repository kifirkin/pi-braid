/**
 * The analyze digest is bounded by construction.
 *
 * Two size paths are unbounded in the raw shape: the Key events list grows
 * with every tool call a session makes, and the whisper by-source line grows
 * with every distinct customType. A single analysis digest must stay inside
 * its token budget whatever the session holds, so both paths are capped and
 * the caps stay honest: the whisper count and the named per-source counts are
 * exact, and a remainder line states how many entries were dropped.
 *
 * Contract:
 *   (a) Key events renders at most KEY_EVENT_LIMIT event lines; each rendered
 *       line is itself capped; the remainder line carries the exact count of
 *       dropped events;
 *   (b) when the key-event cap binds, outcome events (errors, verify calls,
 *       finalize) are kept ahead of plain tool calls, and the kept subset is
 *       rendered in stream order;
 *   (c) the by-source breakdown names the top sources by count and states how
 *       many sources it omitted; the total whisper count stays exact;
 *   (d) a session under both caps is rendered exactly as before - no
 *       remainder lines, no reshaped breakdown;
 *   (e) the `Tools used:` line names at most TOOLS_USED_LIMIT tools, each
 *       clipped to TOOLS_NAME_LIMIT; tools the session actually invoked are
 *       kept ahead of one-off names, and the remainder states the exact
 *       number of dropped names;
 *   (f) the `Session:` line renders paths up to SESSION_PATH_LIMIT chars
 *       verbatim; longer paths keep their trailing whole segments behind an
 *       `…` marker, inside the same limit, so a truncated path is
 *       distinguishable from a full one.
 *
 * Run: node test/runtime/memory/test-session-recall-analyze-bounds.mjs
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { summarizeSession } = await import(
  join(ROOT, "dist", "extensions", "memory", "session-recall", "analyze.js")
);

const KEY_EVENT_LIMIT = 40;
const KEY_EVENT_LINE_LIMIT = 300;
const DIGEST_BOUND = 16_000;
const TOOLS_USED_LIMIT = 40;
const TOOLS_NAME_LIMIT = 40;
const SESSION_PATH_LIMIT = 256;
const TOOLS_LINE_BOUND =
  "Tools used: ".length +
  TOOLS_USED_LIMIT * (TOOLS_NAME_LIMIT + 3) +
  (TOOLS_USED_LIMIT - 1) * 2 +
  40;
const SESSION_LINE_BOUND = "Session: ".length + SESSION_PATH_LIMIT;

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  [fail] ${name}: ${e.message}`);
    });
}

// ── fixture helpers ───────────────────────────────────────────────────────────

const toolCall = (name, args) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
});
const toolResult = (name, text, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolName: name, isError, content: [{ type: "text", text }] },
});
const whisper = (customType, text) => ({
  type: "custom_message",
  customType,
  content: [{ type: "text", text }],
});
const user = (text) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

const dir = mkdtempSync(join(tmpdir(), "analyze-bounds-"));
function fixture(name, lines) {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

/**
 * A real session file at a path of at least `totalLen` chars, built from
 * nested 60-char directory names (the temp dir's own length varies).
 */
function nestedFixture(totalLen) {
  let dirPath = dir;
  for (;;) {
    const candidate = join(dirPath, "n".repeat(60));
    if (join(candidate, "s.jsonl").length > totalLen) break;
    mkdirSync(candidate, { recursive: true });
    dirPath = candidate;
  }
  const file = join(dirPath, "s.jsonl");
  writeFileSync(file, JSON.stringify(user("long path session")) + "\n", "utf-8");
  return file;
}

/** Lines between the `Key events:` header and the section's blank separator. */
function keySectionLines(digest) {
  const lines = digest.split("\n");
  const start = lines.indexOf("Key events:");
  assert.notEqual(start, -1, "the digest must carry a Key events section");
  const end = lines.indexOf("", start + 1);
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}
const eventLines = (digest) =>
  keySectionLines(digest).filter((l) => l.trimStart().startsWith("["));
const bySourceLine = (digest) =>
  digest.split("\n").find((l) => l.includes("By source:")) ?? null;
const toolsLine = (digest) =>
  digest.split("\n").find((l) => l.startsWith("Tools used: ")) ?? null;
const sessionLine = (digest) =>
  digest.split("\n").find((l) => l.startsWith("Session: ")) ?? null;
const whisperCount = (digest) => {
  const m = digest.match(/Injected instructions \(whispers\): (\d+)/);
  return m ? Number(m[1]) : null;
};

const keyEventCount = (summary) =>
  summary.events.filter(
    (e) => e.type === "tool_call" || e.type === "verify" || e.type === "finalize" || e.isError,
  ).length;

/** Pre-cap rendering of the `normal` fixture, minus its temp-path Session line. */
const NORMAL_GOLDEN = `Date: 2026-10-05, Project: pin-project
Messages: 9, Turns: 1
Tools used: read, bash, finalize
Errors: 1

Key events:
  [tool_call] Tool call: read — {"path":"src/index.ts"}
  [tool_call] Tool call: bash — {"command":"node test.mjs"}
  [ERROR] Tool result: bash — boom
  [finalize] Finalize: fixed — {"summary":"fixed"}

Injected instructions (whispers): 3
  By source: enforcement 2, hygiene 1
  [enforcement] [enforcement] run the tests first
  [hygiene] [hygiene] context is fine
  ... (1 more whispers)

Key decisions/messages:
  fix the flaky test
`;

// ── fixtures ──────────────────────────────────────────────────────────────────

// A tool-dense session: 200 tool calls, 10 errors, 5 verify calls, 1 finalize.
// The cap binds well before the end; outcome events must all survive and the
// remaining slots go to the earliest tool calls.
const dense = [user("long automated session")];
for (let i = 0; i < 200; i++) {
  dense.push(toolCall("bash", JSON.stringify({ command: `echo step ${i}` })));
  dense.push(toolResult("bash", `step ${i} done`, i % 20 === 0));
  if (i % 40 === 0) {
    dense.push(toolCall("verify", JSON.stringify({ criteria: ["build passes", "tests pass"] })));
  }
}
dense.push(toolCall("finalize", JSON.stringify({ summary: "all steps complete" })));
const denseFile = fixture("dense", dense);

// Outcome events alone exceed the cap: finalize must outrank an error flood,
// and the error lines that survive are the earliest ones.
const flooded = [user("error-heavy session")];
for (let i = 0; i < 100; i++) {
  flooded.push(toolResult("bash", `failure ${i}`, true));
  if (i % 50 === 0) flooded.push(toolCall("bash", JSON.stringify({ command: `echo ${i}` })));
}
flooded.push(toolCall("verify", JSON.stringify({ criteria: ["one criterion"] })));
flooded.push(toolCall("finalize", JSON.stringify({ summary: "gave up after the flood" })));
const floodedFile = fixture("flooded", flooded);

// A normal short session: under both caps, must render exactly as before.
const normal = [
  user("fix the flaky test"),
  toolCall("read", '{"path":"src/index.ts"}'),
  toolResult("read", "contents"),
  toolCall("bash", '{"command":"node test.mjs"}'),
  toolResult("bash", "boom", true),
  toolCall("finalize", '{"summary":"fixed"}'),
  whisper("enforcement", "[enforcement] run the tests first"),
  whisper("enforcement", "[enforcement] check the output"),
  whisper("hygiene", "[hygiene] context is fine"),
];
const normalFile = fixture("normal", normal);

// Thousands of distinct whisper sources with exact counts: the top four are
// named, the rest are counted, and no line grows with source cardinality.
const manySources = [user("adversarial whisper session")];
for (let i = 0; i < 5; i++) manySources.push(whisper("alpha", `alpha body ${i}`));
for (let i = 0; i < 4; i++) manySources.push(whisper("beta", `beta body ${i}`));
for (let i = 0; i < 3; i++) manySources.push(whisper("gamma", `gamma body ${i}`));
for (let i = 0; i < 2; i++) manySources.push(whisper("delta", `delta body ${i}`));
for (let i = 0; i < 1996; i++) manySources.push(whisper(`eps-${i}`, `ephemeral body ${i}`));
const manySourcesFile = fixture("many-sources", manySources);

// Distinct sources whose names are themselves long: the source label must be
// clipped too, or one name can blow the line.
const longNames = [user("adversarial whisper session")];
for (let i = 0; i < 2000; i++) {
  longNames.push(whisper(`subsystem-${String(i).padStart(5, "0")}-${"n".repeat(50)}`, `body ${i}`));
}
const longNamesFile = fixture("long-names", longNames);

// A key event whose own detail escaped the per-field truncation: a single
// verify criterion of 50,000 chars must not become a 50,000-char digest line.
const giant = [user("giant criteria")];
for (let i = 0; i < 3; i++) {
  giant.push(toolCall("verify", JSON.stringify({ criteria: [`criterion ${i} ${"z".repeat(50000)}`] })));
}
for (let i = 0; i < 20; i++) {
  giant.push(toolCall("bash", JSON.stringify({ command: `echo ${i}` })));
  giant.push(toolResult("bash", "ok"));
}
const giantFile = fixture("giant", giant);

// A sprayed tool-name vocabulary: a thousand one-off names, then the tools the
// session actually invoked, then another thousand one-off names. The cap must
// keep the invoked tools ahead of the spray and state the drop exactly.
const sprayed = [user("tool name spray")];
for (let i = 0; i < 1000; i++) {
  sprayed.push(toolResult(`spray-a-${String(i).padStart(4, "0")}-${"z".repeat(50)}`, "ok"));
}
for (let i = 0; i < 5; i++) sprayed.push(toolCall("bash", JSON.stringify({ command: `echo ${i}` })));
sprayed.push(toolCall("verify", JSON.stringify({ criteria: ["spray stays bounded"] })));
for (let i = 0; i < 1000; i++) {
  sprayed.push(toolResult(`spray-b-${String(i).padStart(4, "0")}-${"z".repeat(50)}`, "ok"));
}
sprayed.push(toolCall("finalize", JSON.stringify({ summary: "done" })));
const sprayedFile = fixture("sprayed", sprayed);

// Three names, each far longer than the per-name clip: the count cap does not
// bind, but the line must still stay inside its bound.
const fewGiant = [user("giant tool names")];
for (let i = 0; i < 3; i++) fewGiant.push(toolResult(`giant-${i}-${"g".repeat(5000)}`, "ok"));
const fewGiantFile = fixture("few-giant-names", fewGiant);

// Fifty names, each far longer than the per-name clip, so the count cap and
// the clip bind at once.
const manyGiant = [user("giant tool names")];
for (let i = 0; i < 50; i++) manyGiant.push(toolResult(`giant-${i}-${"g".repeat(5000)}`, "ok"));
const manyGiantFile = fixture("many-giant-names", manyGiant);

// Real session files whose paths exceed the render limit.
const longPath446 = nestedFixture(446);
const longPath1000 = nestedFixture(1000);

console.log("session-recall analyze digest bounds test\n");

const denseSummary = await summarizeSession(denseFile, "pin-project", "2026-10-05");
const denseEvents = keyEventCount(denseSummary);

await test("the Key events section is capped with a truthful remainder", () => {
  assert.ok(denseEvents > KEY_EVENT_LIMIT, "fixture premise: the cap must bind");
  const rendered = eventLines(denseSummary.compressed);
  assert.equal(rendered.length, KEY_EVENT_LIMIT, "exactly the cap's worth of events");
  const remainder = keySectionLines(denseSummary.compressed).find((l) => /more events/.test(l));
  assert.ok(remainder, "a dropped-event remainder line must be rendered");
  const m = remainder.match(/\((\d+) more events\)/);
  assert.ok(m, `remainder must carry an exact count, got: ${remainder}`);
  assert.equal(Number(m[1]), denseEvents - KEY_EVENT_LIMIT, "dropped count must be exact");
  for (const line of rendered) {
    assert.ok(
      line.length <= KEY_EVENT_LINE_LIMIT + 3,
      `event lines are capped, got ${line.length} chars`,
    );
  }
  assert.ok(
    denseSummary.compressed.length < DIGEST_BOUND,
    `digest must stay bounded, got ${denseSummary.compressed.length} chars`,
  );
});

await test("outcome events survive the cap and fill goes to the earliest tool calls", () => {
  const text = denseSummary.compressed;
  const errors = (text.match(/\[ERROR\]/g) || []).length;
  const verifies = (text.match(/\[verify\]/g) || []).length;
  const finalizes = (text.match(/\[finalize\]/g) || []).length;
  const calls = (text.match(/\[tool_call\]/g) || []).length;
  assert.equal(errors, 10, "every error must be kept");
  assert.equal(verifies, 5, "every verify call must be kept");
  assert.equal(finalizes, 1, "the finalize must be kept");
  assert.equal(calls, KEY_EVENT_LIMIT - 16, "remaining slots go to tool calls");
  assert.ok(text.includes("echo step 0"), "the earliest tool calls are the ones kept");
  assert.ok(!text.includes("echo step 199"), "the tail of the tool-call stream is dropped");
});

await test("outcome priority holds when outcomes alone exceed the cap", async () => {
  const summary = await summarizeSession(floodedFile, "pin-project", "2026-10-05");
  const text = summary.compressed;
  assert.ok(text.includes("[finalize]"), "the session's conclusion outranks the error flood");
  const errors = (text.match(/\[ERROR\]/g) || []).length;
  assert.equal(errors, KEY_EVENT_LIMIT - 1, "the cap minus the finalize goes to the earliest errors");
  const remainder = keySectionLines(text).find((l) => /more events/.test(l));
  assert.equal(
    Number(remainder.match(/\((\d+) more events\)/)[1]),
    keyEventCount(summary) - KEY_EVENT_LIMIT,
  );
});

await test("a session under both caps is rendered unchanged", () => {
  return summarizeSession(normalFile, "pin-project", "2026-10-05").then((summary) => {
    const text = summary.compressed;
    // The Session line is the fixture's own temp path; everything else is the
    // pre-cap rendering, byte for byte.
    const stripped = text
      .split("\n")
      .filter((l) => !l.startsWith("Session:"))
      .join("\n");
    assert.equal(stripped, NORMAL_GOLDEN, "below both caps the digest is unchanged");
    assert.equal(
      text.split("\n")[0],
      `Session: ${normalFile}`,
      "a path under the limit renders verbatim",
    );
    assert.equal(toolsLine(text), "Tools used: read, bash, finalize", "the tool list keeps its shape");
    assert.ok(!/more events/.test(text), "no key-event remainder below the cap");
    assert.equal(eventLines(text).length, 4, "all four key events render");
    assert.equal(
      bySourceLine(text),
      "  By source: enforcement 2, hygiene 1",
      "the breakdown keeps its pre-cap shape and order",
    );
    const lines = text.split("\n");
    const wStart = lines.findIndex((l) => l.startsWith("Injected instructions (whispers):"));
    const wEnd = lines.indexOf("", wStart + 1);
    const wLines = lines.slice(wStart + 1, wEnd === -1 ? lines.length : wEnd);
    const samples = wLines.filter((l) => /^\s{2}\[/.test(l));
    assert.equal(samples.length, 2, "one sample per source, no remainder below the caps");
  });
});

await test("the by-source breakdown names the top sources and counts the rest", () => {
  return summarizeSession(manySourcesFile, "pin-project", "2026-10-05").then((summary) => {
    const text = summary.compressed;
    assert.equal(whisperCount(text), 2010, "the total whisper count stays exact");
    const line = bySourceLine(text);
    assert.ok(
      line.includes("alpha 5, beta 4, gamma 3, delta 2"),
      `top sources by count must be named, got: ${line}`,
    );
    assert.match(line, /\.\.\. \(1996 more sources\)$/);
    assert.ok(
      line.length < 400,
      `the breakdown line must not grow with source cardinality, got ${line.length} chars`,
    );
    assert.ok(
      text.length < DIGEST_BOUND,
      `digest must stay bounded, got ${text.length} chars`,
    );
    assert.ok(line.indexOf("eps-0 ") === -1, "the long tail is omitted, not sampled");
  });
});

await test("long source names are clipped so one name cannot blow the line", () => {
  return summarizeSession(longNamesFile, "pin-project", "2026-10-05").then((summary) => {
    const text = summary.compressed;
    assert.equal(whisperCount(text), 2000);
    const line = bySourceLine(text);
    assert.match(line, /\.\.\. \(1996 more sources\)$/);
    assert.ok(
      line.length < 400,
      `the breakdown line must not grow with source name length, got ${line.length} chars`,
    );
    assert.ok(
      text.length < DIGEST_BOUND,
      `digest must stay bounded, got ${text.length} chars`,
    );
  });
});

await test("a key event's own detail is clipped to the line cap", () => {
  return summarizeSession(giantFile, "pin-project", "2026-10-05").then((summary) => {
    const rendered = eventLines(summary.compressed);
    assert.ok(rendered.length > 0);
    for (const line of rendered) {
      assert.ok(
        line.length <= KEY_EVENT_LINE_LIMIT + 3,
        `event line must be clipped, got ${line.length} chars`,
      );
    }
    assert.ok(
      summary.compressed.length < DIGEST_BOUND,
      `digest must stay bounded, got ${summary.compressed.length} chars`,
    );
  });
});

await test("the Tools used line is capped with an exact remainder and keeps the tools used", () => {
  return summarizeSession(sprayedFile, "pin-project", "2026-10-05").then((summary) => {
    const text = summary.compressed;
    const line = toolsLine(text);
    assert.ok(line, "the digest must carry a Tools used line");
    const remainder = line.match(/, \.\.\. \((\d+) more tools\)$/);
    assert.ok(remainder, `the capped line must carry a remainder, got: ${line.slice(0, 90)}...`);
    assert.equal(
      Number(remainder[1]),
      summary.toolsUsed.length - TOOLS_USED_LIMIT,
      "dropped count must be exact",
    );
    const names = line.slice("Tools used: ".length, line.length - remainder[0].length).split(", ");
    assert.equal(names.length, TOOLS_USED_LIMIT, "exactly the cap's worth of names");
    for (const name of names) {
      assert.ok(name.length <= TOOLS_NAME_LIMIT + 3, `names are clipped, got ${name.length} chars`);
    }
    assert.ok(line.includes("bash"), "a tool invoked five times outranks the spray");
    assert.ok(line.includes("verify"), "verify invocations count as tool use");
    assert.ok(line.includes("finalize"), "finalize invocations count as tool use");
    assert.ok(!line.includes("spray-b-"), "the sprayed tail is what gets dropped");
    assert.ok(line.length <= TOOLS_LINE_BOUND, `the line stays bounded, got ${line.length}`);
    assert.ok(text.length < DIGEST_BOUND, `digest must stay bounded, got ${text.length} chars`);
  });
});

await test("the Tools used line holds its bound for arbitrary name lengths", async () => {
  const few = await summarizeSession(fewGiantFile, "pin-project", "2026-10-05");
  const fewLine = toolsLine(few.compressed);
  assert.ok(!/more tools/.test(fewLine), "the count cap does not bind on three names");
  const fewNames = fewLine.slice("Tools used: ".length).split(", ");
  assert.equal(fewNames.length, 3, "all three names stay named");
  for (const name of fewNames) {
    assert.ok(name.length <= TOOLS_NAME_LIMIT + 3, `names are clipped, got ${name.length} chars`);
  }
  assert.ok(fewLine.length <= TOOLS_LINE_BOUND, `the line stays bounded, got ${fewLine.length}`);

  const many = await summarizeSession(manyGiantFile, "pin-project", "2026-10-05");
  const manyLine = toolsLine(many.compressed);
  assert.match(manyLine, /\.\.\. \(10 more tools\)$/, "the count cap binds and counts the drop");
  const manyNames = manyLine
    .replace(/, \.\.\. \(10 more tools\)$/, "")
    .slice("Tools used: ".length)
    .split(", ");
  assert.equal(manyNames.length, TOOLS_USED_LIMIT, "exactly the cap's worth of names");
  for (const name of manyNames) {
    assert.ok(name.length <= TOOLS_NAME_LIMIT + 3, `names are clipped, got ${name.length} chars`);
  }
  assert.ok(manyLine.length <= TOOLS_LINE_BOUND, `the line stays bounded, got ${manyLine.length}`);
  assert.ok(many.compressed.length < DIGEST_BOUND, `digest must stay bounded`);
});

await test("the Session line renders paths up to the limit verbatim and marks longer ones", async () => {
  const verbatim = await summarizeSession(normalFile, "pin-project", "2026-10-05");
  assert.equal(
    sessionLine(verbatim.compressed),
    `Session: ${normalFile}`,
    "under the limit, verbatim",
  );

  const atLimit = await summarizeSession("x".repeat(SESSION_PATH_LIMIT), "pin-project", "2026-10-05");
  assert.equal(
    sessionLine(atLimit.compressed),
    `Session: ${"x".repeat(SESSION_PATH_LIMIT)}`,
    "a path exactly at the limit is not truncated",
  );

  const overLimit = await summarizeSession(
    "x".repeat(SESSION_PATH_LIMIT + 1),
    "pin-project",
    "2026-10-05",
  );
  const line = sessionLine(overLimit.compressed);
  assert.ok(
    line.startsWith("Session: …"),
    `a truncated path carries the marker, got: ${line.slice(0, 40)}...`,
  );
  assert.ok(line.length <= SESSION_LINE_BOUND, `the line stays bounded, got ${line.length}`);
  assert.ok(!line.includes("x".repeat(SESSION_PATH_LIMIT)), "the full path is not rendered");
});

await test("a long session path is elided to its trailing segments inside the bound", async () => {
  for (const file of [longPath446, longPath1000]) {
    assert.ok(
      file.length > SESSION_PATH_LIMIT,
      `fixture premise: the path exceeds the limit (${file.length} chars)`,
    );
    const summary = await summarizeSession(file, "pin-project", "2026-10-05");
    const line = sessionLine(summary.compressed);
    assert.ok(
      line.length <= SESSION_LINE_BOUND,
      `the line stays bounded, got ${line.length} for a ${file.length}-char path`,
    );
    assert.ok(line.includes("…"), "the elision is marked");
    assert.ok(line.endsWith("/s.jsonl"), "the file name survives");
    const renderedTail = line.slice("Session: ".length + 1);
    assert.ok(file.endsWith(renderedTail), "the rendered tail is a suffix of the real path");
  }
});

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

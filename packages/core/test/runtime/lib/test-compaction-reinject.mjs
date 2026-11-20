/**
 * Test: compaction re-inject — the curated bytes come back, not a request to
 * re-read.
 *
 * Contract. A compaction summarizes the transcript, and a summarized rule is a
 * paraphrase rather than the rule, so the harness returns the curated text
 * itself in the same cycle that dropped it. Two classes, each returned by the
 * owner of its record:
 *
 *   instruction files (AGENTS.md, CLAUDE.md, DESIGN.md) come from the landed
 *   entry's `details.readFiles`, through the compaction curator;
 *   skill bodies come from the skills extension's landed map, through the same
 *   step that used to send a re-read line.
 *
 * Behaviors pinned here:
 * A. Inventory: instruction files the session read are returned byte-identical
 *    to disk, in read order; a source file in the same read record is not.
 * B. Resolution and dedup: one file named relatively and absolutely is one
 *    section, keyed by its resolved path.
 * C. Skill body returned: a delivered body absent from the projection arrives
 *    whole, and the skill's `returned` counter moves while `reloads` does not.
 * D. Present body: a body still in the projection sends nothing and moves
 *    neither counter.
 * E. Ceiling and no truncation: a file past the budget is omitted and named,
 *    and every returned section is its file's full text rather than a cut.
 * F. Silence: no details, or a read record with no instruction file, sends
 *    nothing at all.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never read or written.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "compaction-reinject-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const CURATOR = join(
  ROOT,
  "dist",
  "extensions",
  "memory",
  "context-manager",
  "handlers",
  "compaction-curator.js",
);
const AUTO_INJECT = join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js");
const COMPACTION_HANDLER = join(
  ROOT,
  "dist",
  "extensions",
  "memory",
  "context-manager",
  "handlers",
  "compaction.js",
);

const {
  CURATED_CONTEXT_MAX_CHARS,
  CURATED_INSTRUCTION_FILES,
  collectCuratedInventory,
  formatCuratedText,
  reinjectCuratedContext,
} = await import(CURATOR);
const { registerAutoInject, bodySignature, stripSkillFrontmatter } = await import(AUTO_INJECT);
const { registerSessionCompactHandler } = await import(COMPACTION_HANDLER);
const skillsTool = await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js"));
const { clearAllBuckets } = await import(join(ROOT, "dist", "lib", "utils", "injection-tracker.js"));
const { beginTurn } = await import(join(ROOT, "dist", "lib", "enforcement", "turn-dedup.js"));

after(() => {
  try {
    rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── harness ─────────────────────────────────────────────────────────────────

const WORKSPACE = join(FAKE_HOME, "ws");

/** Minimal ExtensionAPI double: captures handlers, delivered messages, tools. */
function fakePi() {
  const handlers = {};
  const sent = [];
  const tools = new Map();
  return {
    handlers,
    sent,
    tools,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
    registerTool: (definition) => {
      tools.set(definition.name, definition);
    },
    getAllTools: () => [{ name: "read" }, { name: "list_skills" }],
    appendEntry: () => {},
  };
}

/** A context whose model-visible projection is exactly `messages`. */
function ctxFor(messages, sessionId = "reinject") {
  return {
    cwd: WORKSPACE,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(FAKE_HOME, "sessions", `${sessionId}.jsonl`),
      buildSessionProjection: () => ({ messages, entries: [] }),
      getEntries: () => [],
    },
  };
}

/** An instruction file on disk, with content distinct per path. */
function writeInstruction(relPath, body) {
  const path = join(WORKSPACE, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
  return { path, body };
}

/** A plain source file in the same read record: never curated. */
function writeSource(relPath) {
  const path = join(WORKSPACE, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "export const answer = 42;\n", "utf-8");
  return path;
}

/** A skill on disk plus the read result that loads it. */
function writeSkill(name) {
  const filePath = join(WORKSPACE, "skills", name, "SKILL.md");
  const body =
    `# ${name} protocol\n\n` +
    `The ${name} procedure: read this body before acting, because the ${name} ` +
    `rules are the only place the ${name} contract is written down and a seat ` +
    `that acts from memory is a seat that acts on a different contract.\n`;
  const content = `---\nname: ${name}\ndescription: "the ${name} protocol"\n---\n\n${body}`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return { name, filePath, content, body };
}

/** The read tool result that loads a skill body. */
function readResult(skill) {
  return {
    toolName: "read",
    isError: false,
    input: { path: skill.filePath },
    content: [{ text: skill.content }],
  };
}

/** The projection that keeps a body in context. */
const contextWith = (skill) => [
  { role: "system", content: "compaction summary: the session continued." },
  { role: "toolResult", content: [{ type: "text", text: skill.content }] },
];

/** The projection that no longer carries it. */
const contextWithout = () => [
  { role: "system", content: "compaction summary: the bodies read earlier were summarized." },
];

/** Simulate a real turn boundary plus fresh cross-call (reprime) state. */
function newTurn() {
  beginTurn();
  clearAllBuckets();
}

/** The curated messages a pi double was handed. */
const curatedMessages = (pi) => pi.sent.filter((m) => m.params.customType === "context-reinject");

/** The skill deliveries a pi double was handed. */
const skillMessages = (pi) => pi.sent.filter((m) => m.params.customType === "skills-reload");

/** The reply text of one delivered message. */
const textOf = (message) => message.params.content.map((part) => part.text ?? "").join("\n");

/** The skill_stats reply: text payload and details block. */
async function statsFor(ctx, pi) {
  const definition = pi.tools.get("skill_stats");
  assert.ok(definition, "skill_stats is registered");
  const reply = await definition.execute("stats", {}, undefined, undefined, ctx);
  return { text: JSON.parse(reply.content[0].text), details: reply.details };
}

// ── (A) instruction inventory is read-shaped, not extension-shaped ──────────

test("(A) instruction files the session read come back whole; a source file does not", () => {
  const rootContract = writeInstruction("AGENTS.md", "# root\n\nRoot contract body.\n");
  const coreContract = writeInstruction(
    "packages/core/AGENTS.md",
    "# core\n\nCore contract body, long enough to matter.\n",
  );
  const design = writeInstruction("DESIGN.md", "# design\n\nTokens and type scale.\n");
  const source = writeSource("packages/core/src/index.ts");

  // Driven through the registered handler, so this leg covers the call site and
  // not only the module: an inventory that nothing calls is not a delivery.
  const pi = fakePi();
  registerSessionCompactHandler(pi);
  const readFiles = [rootContract.path, source, coreContract.path, design.path];
  newTurn();
  pi.handlers.session_compact(
    {
      reason: "threshold",
      compactionEntry: { id: "compaction-a", summary: "s", details: { readFiles, modifiedFiles: [] } },
    },
    ctxFor([], "reinject-a"),
  );

  const messages = curatedMessages(pi);
  assert.equal(messages.length, 1, "one message per landed compaction");
  const text = textOf(messages[0]);
  const inventory = collectCuratedInventory({ readFiles, cwd: WORKSPACE });
  assert.deepEqual(
    inventory.sections.map((section) => section.path),
    [rootContract.path, coreContract.path, design.path],
    "read order kept, source file excluded",
  );
  for (const section of inventory.sections) {
    assert.equal(
      section.text,
      readFileSync(section.path, "utf-8"),
      `${section.path} is returned as its own bytes`,
    );
    assert.ok(text.includes(section.text), `the handler's message carries ${section.path} whole`);
  }
  for (const file of [rootContract, coreContract, design]) {
    assert.ok(text.includes(file.path), `the message addresses ${file.path}`);
  }
  assert.ok(!text.includes("export const answer"), "the source file's text is not in the message");
  assert.deepEqual(CURATED_INSTRUCTION_FILES, ["AGENTS.md", "CLAUDE.md", "DESIGN.md"]);
});

// ── (B) one file, two spellings, one section ────────────────────────────────

test("(B) a file named relatively and absolutely is one section, resolved", () => {
  const contract = writeInstruction("packages/core/AGENTS.md", "# core\n\nOne body.\n");
  const rel = relative(WORKSPACE, contract.path);

  const inventory = collectCuratedInventory({
    readFiles: [rel, contract.path, "packages/core/AGENTS.md"],
    cwd: WORKSPACE,
  });

  assert.equal(inventory.sections.length, 1, "three spellings of one file are one section");
  assert.equal(inventory.sections[0].path, contract.path, "the section is keyed by resolved path");
});

// ── (C) a lost skill body is returned, and counted as returned ──────────────

test("(C) a delivered body absent from the projection arrives whole, counted returned", async () => {
  const skill = writeSkill("gamma");
  const pi = fakePi();
  registerAutoInject(pi);
  skillsTool.default(pi);
  const ctx = ctxFor(contextWithout(), "reinject-c");

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctx);

  newTurn();
  pi.handlers.session_compact({ reason: "manual" }, ctx);

  assert.equal(skillMessages(pi).length, 1, "exactly one delivery for the skill");
  const text = textOf(skillMessages(pi)[0]);
  const body = stripSkillFrontmatter(skill.content).trim();
  assert.ok(text.includes(body), "the body is in the message, not a pointer to it");
  assert.ok(text.includes(skill.filePath), "the message names the file the body came from");
  assert.equal(
    skillMessages(pi)[0].params.details.returned,
    true,
    "the delivery is marked as a return",
  );

  const { text: reply } = await statsFor(ctx, pi);
  assert.equal(reply.skills.gamma.returned, 1, "returned moved by one");
  assert.equal(reply.skills.gamma.reloads, 0, "reloads did not move: the agent was not sent back");
  assert.ok(bodySignature(body).length >= 40, "the body signs itself, so presence is measurable");
});

// ── (D) a body still in context is not returned ─────────────────────────────

test("(D) a body still in the projection sends nothing and moves no counter", async () => {
  const skill = writeSkill("delta");
  const pi = fakePi();
  registerAutoInject(pi);
  skillsTool.default(pi);
  const ctx = ctxFor(contextWith(skill), "reinject-d");

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctx);

  newTurn();
  pi.handlers.session_compact({ reason: "threshold" }, ctx);

  assert.equal(pi.sent.length, 0, "no message at all while the body is present");
  const { text: reply } = await statsFor(ctx, pi);
  assert.equal(reply.skills.delta.returned, 0, "returned did not move");
  assert.equal(reply.skills.delta.reloads, 0, "reloads did not move");
});

// ── (E) the budget omits a file; nothing is truncated ───────────────────────

test("(E) a file past the budget is omitted and named, never cut", () => {
  const first = writeInstruction("AGENTS.md", "# root\n\n" + "root rule line\n".repeat(40));
  const second = writeInstruction(
    "packages/core/AGENTS.md",
    "# core\n\n" + "core rule line\n".repeat(200),
  );
  const third = writeInstruction("DESIGN.md", "# design\n\n" + "token line\n".repeat(40));

  // The prefix rule, under a budget that admits the first file and nothing
  // after it: no file is ever returned as a cut, so the ones that do not fit
  // are named with the reason instead.
  const budgeted = collectCuratedInventory({
    readFiles: [first.path, second.path, third.path],
    cwd: WORKSPACE,
    maxChars: first.body.length + third.body.length + 10,
  });
  assert.deepEqual(
    budgeted.sections.map((section) => section.path),
    [first.path],
    "only the file that fits is returned",
  );
  assert.equal(budgeted.sections[0].text, first.body, "a returned section equals its file, byte for byte");
  assert.deepEqual(
    budgeted.omitted.map((item) => item.reason),
    ["over-budget", "over-budget"],
    "a file past the break is named, and so is every later one: a prefix, not a scattered pick",
  );

  // The shipped ceiling, end to end: a file too big for the message is named as
  // a pointer in the same message that carries the file that fits, so the reader
  // is never handed half of it.
  const small = writeInstruction("DESIGN.md", "# design\n\ntokens\n");
  const big = writeInstruction("packages/core/AGENTS.md", "# core\n\n" + "core rule line\n".repeat(2000));
  const pi = fakePi();
  newTurn();
  reinjectCuratedContext(pi, ctxFor([]), {
    details: { readFiles: [small.path, big.path], modifiedFiles: [] },
  });
  const messages = curatedMessages(pi);
  assert.equal(messages.length, 1, "the message with the file that fits goes out");
  const text = textOf(messages[0]);
  assert.ok(big.body.length > CURATED_CONTEXT_MAX_CHARS, "the fixture file exceeds the ceiling");
  assert.ok(text.includes(small.body.trim()), "the file that fits is returned whole");
  assert.ok(!text.includes(big.body.slice(0, 200).trim()), "the over-budget body is not cut in");
  assert.ok(text.includes(big.path), "the omitted file is still named as a pointer");
  assert.equal(CURATED_CONTEXT_MAX_CHARS, 24_000, "the shipped ceiling is the documented one");
  assert.equal(formatCuratedText({ sections: [], omitted: [] }), "", "no sections, no message");

  // Nothing fits: no body means no message. A delivery that carries only a
  // pointer is the re-read invitation this path exists to replace.
  const silent = fakePi();
  newTurn();
  reinjectCuratedContext(silent, ctxFor([]), {
    details: { readFiles: [big.path], modifiedFiles: [] },
  });
  assert.equal(curatedMessages(silent).length, 0, "a fully over-budget record stays silent");
});

// ── (F) silence is the default ──────────────────────────────────────────────

test("(F) no details, or a read record with no instruction file, sends nothing", () => {
  const source = writeSource("packages/core/src/index.ts");
  const pi = fakePi();
  const ctx = ctxFor([]);

  reinjectCuratedContext(pi, ctx, undefined);
  reinjectCuratedContext(pi, ctx, { details: { readFiles: [] } });
  reinjectCuratedContext(pi, ctx, { details: { readFiles: [source] } });

  assert.equal(pi.sent.length, 0, "a compaction with no curated file is silent");
});


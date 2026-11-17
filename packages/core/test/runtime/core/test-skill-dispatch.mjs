/**
 * Test: the skill whisper routes a dispatch to the WORK, and claims only what
 * its evidence supports.
 *
 * Three properties, each with the case that produced it:
 *
 *   1. A worker dispatch goes to the skill that declares the work, or to no
 *      skill at all — never to `braid-reference` on the strength of the
 *      dispatch's own words. The recorded dispatch below (a couples-band fix on
 *      a website, addressed to an implementation worker) is reproduced word for
 *      word, with the operator's home, worktree and worker id generalized; on
 *      it, `braid-reference` is the catalog's best-scoring row, because its
 *      description is `workers and the orchestrator registry, ... the skills
 *      catalog` and a dispatch says exactly those words. The arm below asserts
 *      the row is gone, and the second arm asserts the routing survives: a
 *      dispatch whose subject a code skill declares still reaches that skill.
 *
 *   2. A process-only match is reported, never expanded. A phrase made only of
 *      dispatch vocabulary (`orchestrator registry`) matches the dispatch, so
 *      the message names what it matched and says why it is not the work; it
 *      carries no body and makes no claim.
 *
 *   3. The counters follow the message. `suggested` moves for the rows a
 *      delivered message names, `fullBody` moves only when a body landed.
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-dispatch-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { registerAutoInject, getSkillStats, formatSkillNotice, extractKeywords, MIN_NON_NAME_SIGNALS } =
  await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js"));
const { setCachedSkills, default: skillsToolExtension } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js")
);
const { readSkillTriggers } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "skill-triggers.js")
);
const { clearAllBuckets } = await import(join(ROOT, "dist", "lib", "utils", "injection-tracker.js"));
const { beginTurn } = await import(join(ROOT, "dist", "lib", "enforcement", "turn-dedup.js"));

// ── the recorded dispatch ──────────────────────────────────────────────────

/**
 * A verbatim worker dispatch, recorded from a session that edited a
 * percentage→word table on a numerology site. Generalized in three places only,
 * because each names a machine rather than the work: the operator's home
 * (`/Users/…` → `/srv/agent`), the worktree (`/private/tmp/wt-forest-band` →
 * `/work/wt-band`), and the worker id (an invented placeholder). Everything else — the
 * brief path, the report path, the branch, the commit hash, the dispatch
 * sentence, the defect paragraph — is as it was sent.
 */
const RECORDED_DISPATCH = `Read /srv/agent/braid/orchestrator/briefs/FOREST-COUPLES-BAND-2026-11-15.md in full before anything else, then read the report it points at (/srv/agent/braid-docs/reports/FOREST-COUPLES-BAND-2026-11-15.md) and execute the brief. You are worker w1, spec impl, worktree /work/wt-band on branch worker/w1/forest-band based on prerender at 650eed2, deliverable /srv/agent/braid-docs/reports/FOREST-COUPLES-BAND-IMPL-2026-11-15.md.

The defect: the couples panel prints the six-rung level ladder's word under the headline percentage, while the page it reproduces prints three words keyed on the percentage itself (66-75 хорошая, 76-85 отличная, 86 and above негативный повтор, nothing below 66). The rule is measured over 175 readings with zero violations and I re-read ten pairs from the live page myself; the level cells underneath keep their own ladder and must not move.

One commit, no push/tag/publish/merge/deploy, only the seven named paths. Call list_skills first. The three planted reverts must each go red and their output belongs in the report. If the reference page is unreachable, report blocked rather than completed. End your final chat message with the fenced JSON result block, validated with check-result.mjs until it prints RESULT: PASS.`;

/**
 * A dispatch of the same shape whose subject a shipped code skill declares
 * (`code-refactoring`: "restructure/move/rename files or symbols across a
 * TypeScript codebase", trigger `ast-grep`). Same ceremony, different work.
 */
const REFACTOR_DISPATCH = `Read /srv/agent/braid/orchestrator/briefs/SYMBOL-RENAME-2026-11-15.md in full before anything else and execute the brief. You are worker w2, spec impl, worktree /work/wt-rename on branch worker/w2/rename, deliverable /srv/agent/braid-docs/reports/SYMBOL-RENAME-IMPL-2026-11-15.md.

The symbol \`gatewayProvider\` is renamed to \`agentZero\` across the TypeScript codebase: the rename must reach every import and every call site, and ast-grep is the tool for it rather than sed or regex. Update the imports in the packages that use it and leave the exported surface unchanged.

One commit, no push/tag/publish/merge/deploy. End your final chat message with the fenced JSON result block, validated with check-result.mjs until it prints RESULT: PASS.`;

/** A braid-internals question: the one subject `braid-reference` declares. */
const BRAID_DOCS_QUESTION =
  "braid docs question: which document owns the timers and wakes, and what does the skills catalog say about compaction?";

/** Dispatch vocabulary and one word that is not: the prompt carries a task. */
const PROCESS_ONLY_PROMPT = "the orchestrator registry logged the run";

// ── the catalog ────────────────────────────────────────────────────────────

/** First `key: value` line for `key` in a frontmatter block, or null. */
function field(front, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(front);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

function frontmatterOf(text) {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  return end < 0 ? "" : text.slice(4, end);
}

/** The shipped core catalog, read from the tree: real descriptions, real phrases. */
function coreCatalog() {
  const dir = join(ROOT, "skills");
  const rows = [];
  for (const name of readdirSync(dir).sort()) {
    const filePath = join(dir, name, "SKILL.md");
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const front = frontmatterOf(text);
    const description = field(front, "description") ?? "";
    rows.push({
      name: field(front, "name") ?? name,
      filePath,
      description,
      baseDir: join(dir, name),
      triggers: readSkillTriggers(filePath, description),
    });
  }
  return rows;
}

const CATALOG = coreCatalog();

/** A skill whose only relevance signal is dispatch vocabulary. */
const WATCH_DIR = join(FAKE_HOME, "skills", "dispatch-watch");
mkdirSync(WATCH_DIR, { recursive: true });
const WATCH_FILE = join(WATCH_DIR, "SKILL.md");
writeFileSync(
  WATCH_FILE,
  `${frontmatterText("dispatch-watch", "Notes kept about the run itself.", ["orchestrator registry"])}\n\n# Dispatch watch\n\nNothing here names a task.\n`,
  "utf8",
);
const WATCH = {
  name: "dispatch-watch",
  description: "Notes kept about the run itself.",
  filePath: WATCH_FILE,
  baseDir: join(FAKE_HOME, "skills"),
  triggers: ["orchestrator registry"],
  triggerSources: { "orchestrator registry": "frontmatter" },
};

function frontmatterText(name, description, triggers) {
  return `---\nname: ${name}\ndescription: ${description}\ntriggers:\n${triggers.map((t) => `  - "${t}"`).join("\n")}\n---`;
}

// ── pi double ──────────────────────────────────────────────────────────────

function fakePi() {
  const handlers = {};
  const stream = [];
  const tools = [];
  return {
    handlers,
    stream,
    tools,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerTool: (tool) => tools.push(tool),
    getAllTools: () => tools.map((t) => ({ name: t.name })),
    sendMessage: (params, options) => {
      if (options?.triggerTurn) {
        stream.push(params);
        return;
      }
      if (options?.deliverAs !== "nextTurn") stream.push(params);
    },
  };
}

let sessionSeq = 0;
function openSession() {
  sessionSeq++;
  const pi = fakePi();
  skillsToolExtension(pi);
  registerAutoInject(pi);
  const ctx = {
    sessionManager: { getSessionId: () => `dispatch-${sessionSeq}` },
    cwd: join(FAKE_HOME, "ws"),
  };
  beginTurn();
  clearAllBuckets();
  return { pi, ctx };
}

const skillMessages = (pi) =>
  pi.stream.filter((m) => m.customType === "skills-suggestion" || m.customType === "skills-notice");
const textOf = (message) => message.content.map((c) => c.text ?? "").join("\n");
/** A first-class body section: `## <name> (full text, ...)` or `(first N chars...)`. */
const inlinesBody = (text) => /^## .+\((?:full text|first \d+ characters)/m.test(text);
const names = (message) => message.details?.skills ?? [];

// ── B1: the dispatch does not buy braid-reference a slot ───────────────────

test("B1: the recorded dispatch names no declaration, and never braid-reference", async () => {
  setCachedSkills(CATALOG);
  const { pi, ctx } = openSession();
  await pi.handlers.before_agent_start({ prompt: RECORDED_DISPATCH }, ctx);

  const sent = skillMessages(pi);
  assert.equal(sent.length, 1, "the turn delivered one skill message");
  const message = sent[0];
  const text = textOf(message);

  assert.ok(
    !names(message).includes("braid-reference"),
    `braid-reference was offered on a dispatch: ${names(message).join(", ")}`,
  );
  assert.ok(!text.includes("braid-reference"), "braid-reference is not named in the message");
  assert.ok(
    !text.includes("best match"),
    `the message claims a best match on dispatch vocabulary:\n${text.slice(0, 400)}`,
  );
  assert.equal(message.customType, "skills-notice", "the turn is a report, not a suggestion");
  assert.ok(!inlinesBody(text), "no SKILL.md body arrived on a dispatch");
  assert.ok(
    text.includes("The catalog in the prompt lists every skill"),
    "the message points at the catalog the prompt already carries",
  );
  assert.ok(
    /^- \S+: `[^`]+` \(/m.test(text),
    "every row the message names prints the terms it matched",
  );
});

test("B1: a dispatch whose subject a code skill declares still reaches that skill", async () => {
  setCachedSkills(CATALOG);
  const { pi, ctx } = openSession();
  await pi.handlers.before_agent_start({ prompt: REFACTOR_DISPATCH }, ctx);

  const sent = skillMessages(pi);
  assert.equal(sent.length, 1, "the turn delivered one skill message");
  const message = sent[0];
  const text = textOf(message);

  assert.equal(
    names(message)[0],
    "code-refactoring",
    `the work's skill is not first: ${names(message).join(", ")}`,
  );
  assert.ok(!names(message).includes("braid-reference"), "braid-reference stays out of it");
  assert.ok(
    text.includes("code-refactoring is the best match for this task"),
    "a decided match is still stated as one",
  );
  assert.ok(
    text.includes("`ast-grep` (trigger phrase)"),
    `the claim names the term it stands on:\n${text.slice(0, 300)}`,
  );
  assert.equal(message.details?.fullBody, "code-refactoring", "the decided body still arrives");
  assert.ok(inlinesBody(text), "and arrives as a body, not an excerpt");
});

test("B1: the work's code skill shares only incidental words, and does not reach the message", async () => {
  // The measurement behind the assertion above, printed so a reader can check
  // it. `software-engineer` is the shipped declaration that governs editing a
  // table in a source file, and it shares three words with this dispatch —
  // `read` (inside "read → critique → suggest"), `execute`, and `under`
  // (inside "understand"). All three are accidents of a substring test, and
  // the row they qualify scores below the rows the notice names, so the
  // dispatch's own subject reaches no code skill. That is a fact about the
  // shipped declarations, not about the matcher: no code skill's file names a
  // percentage table, a React component or a couples panel.
  const keywords = extractKeywords(RECORDED_DISPATCH);
  assert.ok(keywords.length > 20, `the dispatch carries ${keywords.length} work keywords`);
  const engineer = CATALOG.find((s) => s.name === "software-engineer");
  assert.ok(engineer, "the catalog carries software-engineer");
  const shared = keywords.filter((k) => engineer.description.toLowerCase().includes(k));
  console.log(
    `  dispatch keywords: ${keywords.length}; shared with software-engineer's declaration: ` +
      `${JSON.stringify(shared)} (bar is ${MIN_NON_NAME_SIGNALS})`,
  );
  assert.ok(shared.length > 0, "the code skill shares something, so the notice is not 'the catalog is empty'");
  assert.ok(shared.length < 5, `the code skill shares ${shared.length} words: the match is not incidental`);

  setCachedSkills(CATALOG);
  const { pi, ctx } = openSession();
  await pi.handlers.before_agent_start({ prompt: RECORDED_DISPATCH }, ctx);
  const message = skillMessages(pi)[0];
  assert.ok(
    !names(message).includes("software-engineer"),
    `the code skill reached the message, which this measurement says it cannot: ${names(message).join(", ")}`,
  );
});

// ── B3: the line stops claiming more than the evidence ─────────────────────

test("B3: a process-only match is named, not expanded", async () => {
  setCachedSkills([...CATALOG, WATCH]);
  const { pi, ctx } = openSession();
  await pi.handlers.before_agent_start({ prompt: PROCESS_ONLY_PROMPT }, ctx);

  const sent = skillMessages(pi);
  assert.equal(sent.length, 1, "the turn delivered one message");
  const message = sent[0];
  const text = textOf(message);

  assert.deepEqual(names(message), ["dispatch-watch"], "the row that matched is the row named");
  assert.ok(
    text.includes("`orchestrator registry` (trigger phrase)"),
    `the message names what it matched:\n${text}`,
  );
  assert.ok(
    text.includes("braid's own vocabulary, not this task's subject"),
    "and says why that is not the work",
  );
  assert.ok(!text.includes("best match"), "no claim on dispatch vocabulary");
  assert.equal(message.customType, "skills-notice", "a report, not a suggestion");
  assert.ok(!inlinesBody(text), "no body was expanded on it");
  assert.equal(message.details?.fullBody, undefined, "nothing is recorded as a body delivery");
});

test("B3: a genuine domain match still arrives as a body", async () => {
  setCachedSkills(CATALOG);
  const { pi, ctx } = openSession();
  await pi.handlers.before_agent_start({ prompt: BRAID_DOCS_QUESTION }, ctx);

  const sent = skillMessages(pi);
  assert.equal(sent.length, 1, "the turn delivered one skill message");
  const message = sent[0];
  const text = textOf(message);

  assert.equal(names(message)[0], "braid-reference", "the braid-docs question reaches its skill");
  assert.equal(message.customType, "skills-suggestion", "the suggestion tier still exists");
  assert.equal(message.details?.fullBody, "braid-reference", "the body still arrives");
  assert.ok(inlinesBody(text), "as a body section");
  assert.ok(
    text.includes("`braid docs` (trigger phrase)"),
    `with the phrase the pick stands on:\n${text.slice(0, 300)}`,
  );
});

// ── B4: the counters follow the message ────────────────────────────────────

test("B4: suggested follows the delivered message and fullBody only a body", async () => {
  setCachedSkills(CATALOG);
  const { pi, ctx } = openSession();

  await pi.handlers.before_agent_start({ prompt: RECORDED_DISPATCH }, ctx);
  const notice = skillMessages(pi)[0];
  const rows = names(notice);
  assert.ok(rows.length > 0, "the notice named at least one row");
  let stats = getSkillStats(ctx);
  for (const name of rows) {
    assert.equal(stats[name]?.suggested, 1, `${name} was named once, so it counts once`);
    assert.equal(stats[name]?.fullBody, 0, `${name} carried no body, so no body count`);
    assert.equal(stats[name]?.loaded, 0, "a message is not a load");
  }
  assert.equal(
    stats["braid-reference"]?.suggested ?? 0,
    0,
    "braid-reference was not named, so it is not counted",
  );

  const { pi: pi2, ctx: ctx2 } = openSession();
  await pi2.handlers.before_agent_start({ prompt: BRAID_DOCS_QUESTION }, ctx2);
  const picked = skillMessages(pi2)[0];
  assert.equal(picked.details?.fullBody, "braid-reference", "the domain turn delivered a body");
  const stats2 = getSkillStats(ctx2);
  assert.equal(stats2["braid-reference"]?.suggested, 1, "the body delivery is a suggestion too");
  assert.equal(stats2["braid-reference"]?.fullBody, 1, "and a body delivery on its own counter");
});

// ── the renderer, pinned ───────────────────────────────────────────────────

test("formatSkillNotice prints each row's terms and claims nothing", () => {
  const text = formatSkillNotice([
    {
      skill: WATCH,
      score: 2,
      signals: 1,
      evidenceDf: 0,
      terms: [{ term: "orchestrator registry", field: "trigger", process: true }],
      processOnly: true,
      identity: false,
    },
  ]);
  assert.ok(text.includes("[SKILL SUGGESTION]"), "the message keeps the whisper's own tag");
  assert.ok(!text.includes("best match"), "it makes no best-match claim");
  assert.ok(!inlinesBody(text), "and carries no body");
  assert.ok(text.includes("`orchestrator registry` (trigger phrase)"), "the term is printed");
  assert.ok(text.includes("braid's own vocabulary"), "with its class named");
});

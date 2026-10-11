/**
 * Session-recall project labels and archive accounting.
 *
 * Defects fixed here:
 *  1. `projectFromPath` decoded the encoded session directory name by replacing
 *     every `-` with `/`. The encoding (`--<cwd with / and : replaced by ->--`)
 *     is lossy: `-` is both the separator and a legal character in a name, so
 *     `--Users-<user>-projects-agents-pi-braid--` came out as
 *     `projects/agents/pi/braid`. Every braid session was labelled with a
 *     project that does not exist, and the printed label could not be used as
 *     the `project` filter (which matched the raw path only).
 *  2. `stats` counted a compaction archive as one undated session and reported
 *     nothing about it, so the archived messages were invisible in the totals.
 *
 * Checked here on a fixture tree that reproduces both recorded directory names:
 *  (a) NEGATIVE CONTROL / RED: `legacyProjectFromPath` - the pre-fix decoder
 *      copied verbatim - returns `projects/agents/pi/braid` for the recorded
 *      pi-braid directory, asserted in the same run in which the new
 *      `projectFromPath` returns `projects/agents/pi-braid`. Remove the header
 *      lookup and (b) fails while (a) stays true.
 *  (b) The recorded paths: the pi-braid session file, its `archives/` path, and
 *      a `--private-tmp--` path each render the human-readable project AND a
 *      date (never `unknown`).
 *  (c) The printed label is usable as a filter: `pathMatchesProject` accepts
 *      it, still accepts the raw encoded substring, and rejects other projects.
 *  (d) `collectSessionStats` (the production aggregation behind
 *      `session action=stats`) counts the archive file and the archived
 *      messages, keeps the archive in `entries`, and files it under the SAME
 *      project as its live siblings - one project row, not two.
 *  (e) The archive count is date-driven, not class-driven: an archive inside the
 *      window is counted, one outside it is not, and `countArchivedMessages`
 *      counts the stored payload while returning 0 for a live line.
 *
 * Run: node test/runtime/memory/test-session-paths-and-stats.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const { projectFromPath, dateFromPath, pathMatchesProject } = await import(
  "../../../dist/extensions/memory/session-recall/search.js"
);
const { collectSessionStats, isArchivePath } = await import(
  "../../../dist/extensions/memory/session-recall/stats.js"
);
const { countArchivedMessages } = await import(
  "../../../dist/extensions/memory/session-recall/text-utils.js"
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

// ── The pre-fix decoder, verbatim (negative control) ─────────────────────────

function legacyProjectFromPath(sessionPath) {
  const match = sessionPath.match(/sessions[/\\](--.*?--)[/\\]/);
  if (!match || !match[1]) return "~";
  let encoded = match[1].slice(2, -2);
  const homeEncoded = homedir()
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-");
  if (encoded.startsWith(homeEncoded + "-")) {
    encoded = encoded.slice(homeEncoded.length + 1);
  } else if (encoded === homeEncoded) {
    return "~";
  }
  return encoded.replace(/-/g, "/") || "~";
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const HOME_ENCODED = homedir()
  .replace(/^[/\\]/, "")
  .replace(/[/\\:]/g, "-");

/** The recorded directory name for this machine's pi-braid checkout. */
const BRAID_DIR_NAME = `--${HOME_ENCODED}-projects-agents-pi-braid--`;
const BRAID_CWD = join(homedir(), "projects", "agents", "pi-braid");

const LIVE_FILE = "2026-09-29T11-38-39-022Z_01a0ecf5-ae2d-75cc-b630-6ef898d3a54e.jsonl";
const ARCHIVE_FILE = "01a0c7ff-c90c-7338-9b9e-ce9a88c2b63e-9d641cb4-1790066163578.jsonl";
const PRIVATE_FILE = "2026-09-29T11-38-39-022Z_01a0ecf5-ae2d-75cc-b630-6ef898d3a54f.jsonl";

const ARCHIVED_MESSAGES = 3;
/** Pinned archive mtime: archives are named by session+leaf+epoch, with no date. */
const ARCHIVE_MTIME = new Date("2026-09-21T12:00:00.000Z");
const ARCHIVE_DATE = "2026-09-21";

function sessionHeader(cwd, timestamp) {
  return JSON.stringify({ type: "session", version: 3, id: "sess", timestamp, cwd });
}

function archiveEnvelope(count) {
  const originals = Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `archived message ${i}` }],
  }));
  return JSON.stringify({
    sessionId: "01a0c7ff-c90c-7338-9b9e-ce9a88c2b63e",
    leafId: "9d641cb4",
    reason: "threshold",
    timestamp: "2026-09-21T11:00:00.000Z",
    compactedMessages: count,
    keptMessages: 2,
    originals: JSON.stringify(originals),
  });
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "session-paths-"));
  const sessions = join(root, "sessions");

  const braidDir = join(sessions, BRAID_DIR_NAME);
  const archiveDir = join(braidDir, "archives");
  await mkdir(archiveDir, { recursive: true });
  const livePath = join(braidDir, LIVE_FILE);
  await writeFile(
    livePath,
    sessionHeader(BRAID_CWD, "2026-09-29T11:38:39.022Z") + "\n" + JSON.stringify({ type: "message" }) + "\n",
  );
  const archivePath = join(archiveDir, ARCHIVE_FILE);
  await writeFile(archivePath, archiveEnvelope(ARCHIVED_MESSAGES) + "\n");
  await utimes(archivePath, ARCHIVE_MTIME, ARCHIVE_MTIME);

  const tmpDir = join(sessions, "--private-tmp--");
  await mkdir(tmpDir, { recursive: true });
  const privatePath = join(tmpDir, PRIVATE_FILE);
  await writeFile(privatePath, sessionHeader("/private/tmp", "2026-09-29T11:38:39.022Z") + "\n");

  return { root, livePath, archivePath, privatePath };
}

const fixture = await buildFixture();

// ── (a) negative control ─────────────────────────────────────────────────────

await test("RED: the pre-fix decoder mislabels the recorded pi-braid directory", async () => {
  const recorded = `${homedir()}/.pi/agent/sessions/${BRAID_DIR_NAME}/${LIVE_FILE}`;
  assert.equal(legacyProjectFromPath(recorded), "projects/agents/pi/braid");
  assert.equal(legacyProjectFromPath(fixture.livePath), "projects/agents/pi/braid");
  assert.notEqual(
    legacyProjectFromPath(fixture.livePath),
    projectFromPath(fixture.livePath),
    "the fix must change the answer for this fixture",
  );
});

// ── (b) the recorded paths ───────────────────────────────────────────────────

await test("live session file: project and date", async () => {
  assert.equal(projectFromPath(fixture.livePath), "projects/agents/pi-braid");
  assert.equal(dateFromPath(fixture.livePath), "2026-09-29");
});

await test("archive path: same project as its live siblings, dated from mtime", async () => {
  assert.ok(isArchivePath(fixture.archivePath), "fixture archive lives under archives/");
  assert.equal(projectFromPath(fixture.archivePath), "projects/agents/pi-braid");
  assert.equal(dateFromPath(fixture.archivePath), ARCHIVE_DATE);
});

await test("--private-tmp-- path: project and date unchanged by the fix", async () => {
  assert.equal(projectFromPath(fixture.privatePath), "private/tmp");
  assert.equal(dateFromPath(fixture.privatePath), "2026-09-29");
});

// ── (c) the label is a usable filter ─────────────────────────────────────────

await test("pathMatchesProject accepts the printed label and the raw path", async () => {
  assert.equal(pathMatchesProject(fixture.livePath, "projects/agents/pi-braid"), true);
  assert.equal(pathMatchesProject(fixture.archivePath, "projects/agents/pi-braid"), true);
  assert.equal(pathMatchesProject(fixture.livePath, BRAID_DIR_NAME), true);
  assert.equal(pathMatchesProject(fixture.livePath, "projects/agents/pi-braid-clean"), false);
  assert.equal(pathMatchesProject(fixture.livePath, "private/tmp"), false);
});

// ── (d) stats counts the archive, once, under the right project ──────────────

await test("collectSessionStats counts archives and their messages", async () => {
  const files = [fixture.livePath, fixture.archivePath, fixture.privatePath];
  const totals = await collectSessionStats(files, { project: "projects/agents/pi-braid" });

  const paths = totals.entries.map((e) => e.path);
  assert.ok(paths.includes(fixture.archivePath), "the archive is not dropped from entries");
  assert.equal(totals.entries.length, 2, "only the two pi-braid files match the filter");
  assert.equal(new Set(totals.entries.map((e) => e.project)).size, 1, "one project row, not two");
  assert.equal(totals.entries[0].project, "projects/agents/pi-braid");
  assert.deepEqual(totals.archives, { files: 1, messages: ARCHIVED_MESSAGES });
});

await test("unfiltered stats file the archive under the same project as the live session", async () => {
  const totals = await collectSessionStats([fixture.livePath, fixture.archivePath]);
  const byProject = new Map();
  for (const e of totals.entries) byProject.set(e.project, (byProject.get(e.project) ?? 0) + 1);
  assert.deepEqual([...byProject.entries()], [["projects/agents/pi-braid", 2]]);
});

// ── (e) the archive count is date-driven ─────────────────────────────────────

await test("an archive inside the window is counted, one outside it is not", async () => {
  const files = [fixture.archivePath];
  const inside = await collectSessionStats(files, {
    since: Date.parse("2026-09-21T00:00:00.000Z"),
    until: Date.parse("2026-09-21T23:59:59.999Z"),
  });
  assert.deepEqual(inside.archives, { files: 1, messages: ARCHIVED_MESSAGES });

  const outside = await collectSessionStats(files, {
    since: Date.parse("2026-09-22T00:00:00.000Z"),
  });
  assert.deepEqual(outside.archives, { files: 0, messages: 0 });
  assert.equal(outside.entries.length, 0);
});

await test("countArchivedMessages counts the stored payload, not the file", async () => {
  assert.equal(countArchivedMessages(archiveEnvelope(7)), 7);
  assert.equal(countArchivedMessages(archiveEnvelope(0)), 0);
  assert.equal(countArchivedMessages(sessionHeader(BRAID_CWD, "2026-09-29T11:38:39.022Z")), 0);
  assert.equal(countArchivedMessages("{not json"), 0);
});

await rm(fixture.root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

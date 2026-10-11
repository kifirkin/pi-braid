/**
 * Session-recall ranking by occurrences, recency, project and role.
 *
 * Defect: the search path ranked candidate files by matching *line* count. A
 * term hit many times on one long compaction-archive line scored the same as a
 * file with many sparse matching lines, and nothing else the search already
 * knew — when the session was, which project, whether the hit was in a user
 * turn — entered the order. The first archive of a recorded common-token run
 * sat at rank 166, outside the ten rendered.
 *
 * Checked here:
 *  (a) The score is a blend of four signals, each moving the order on its own
 *      (occurrences, recency, project, role) — synthetic candidates, no I/O.
 *  (b) RED: on a fixture where line count and occurrence count disagree (a live
 *      file with many sparse matching lines, an archive with a dense token in
 *      one long line), the pre-fix line-count ranker puts the archive BELOW the
 *      live file and the new ranker puts it ABOVE. The archive's rank improves.
 *  (c) The control token keeps the live files' top-10 order unchanged, so the
 *      change is scoped to the archive/occurrence case and does not reshuffle
 *      ordinary live results.
 *  (d) Three fixed queries, before/after top-10 lists pinned, so a future
 *      weighting change cannot quietly overfit one query. Each query exercises
 *      a different signal; the archive-bearing query's first-archive rank
 *      improves.
 *
 * The legacy ranker below is the pre-fix ordering, mirrored with `rg -c`
 * (line counts); it is present so the RED is asserted in the same run, and so
 * the file still runs against a pre-fix build of the module (no
 * `rankSearchResults` export).
 *
 * Run: node test/runtime/memory/test-session-ranking.mjs
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const search = await import("../../../dist/extensions/memory/session-recall/search.js");
const { searchFiles } = search;
// Pre-fix builds do not export the label helper; the fallback lets the RED run
// reach the behavioural assertions instead of crashing at load.
const labelFromCwd = search.labelFromCwd ?? ((cwd) => cwd);
const rankModule = await import("../../../dist/extensions/memory/session-recall/rank.js").catch(
  () => null,
);
const rankSearchResults = rankModule?.rankSearchResults;

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

// ── Pre-fix ranking, mirrored (`rg -c` line counts) ──────────────────────────

function rgLines(patterns, dir) {
  let output;
  try {
    output = execFileSync(
      "rg",
      ["-i", "-c", "-F", ...patterns.flatMap((p) => ["-e", p]), dir],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.lastIndexOf(":");
      return { path: line.slice(0, i), count: parseInt(line.slice(i + 1), 10) };
    });
}

function legacySearchFiles(query, dir) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6);
  if (terms.length <= 1) {
    const matches = rgLines([query], dir);
    const weight = 1 / (1 + matches.length);
    return matches.map((m) => ({ ...m, phrase: m.count, terms: 1, score: weight }));
  }
  const phrase = new Map(rgLines([query], dir).map((h) => [h.path, h.count]));
  const perTerm = terms.map((t) => new Map(rgLines([t], dir).map((h) => [h.path, h.count])));
  const weights = perTerm.map((files) => 1 / (1 + files.size));
  const merged = new Map();
  perTerm.forEach((files, i) => {
    for (const [path, count] of files) {
      const entry = merged.get(path) ?? { path, count, terms: 0, score: 0, phrase: 0 };
      entry.count = Math.max(entry.count, count);
      entry.terms += 1;
      entry.score += weights[i];
      merged.set(path, entry);
    }
  });
  for (const [path, count] of phrase) {
    const entry = merged.get(path) ?? { path, count, terms: terms.length, score: 0, phrase: 0 };
    entry.phrase = count;
    merged.set(path, entry);
  }
  return [...merged.values()];
}

function legacyRank(matches) {
  return [...matches].sort(
    (a, b) =>
      (b.phrase ?? 0) - (a.phrase ?? 0) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      b.count - a.count ||
      b.path.localeCompare(a.path),
  );
}

const names = (list) => list.map((m) => basename(m.path));

// ── Fixture builders ─────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-30T00:00:00.000Z");

function header(cwd) {
  return JSON.stringify({ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd });
}

function userLine(text) {
  return JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function archiveEnvelope(messages) {
  return JSON.stringify({
    sessionId: "sess",
    leafId: "leaf",
    reason: "compact",
    timestamp: "2026-01-01T00:00:00.000Z",
    compactedMessages: messages.length,
    keptMessages: 0,
    originals: JSON.stringify(messages),
  });
}

const rawUser = (text) => ({ role: "user", content: [{ type: "text", text }] });

const ALPHA_DIR = "--Users-tester-alpha--";
const ALPHA_CWD = "/Users/tester/alpha";
const CURRENT_PROJECT = labelFromCwd(ALPHA_CWD);

const root = await mkdtemp(join(tmpdir(), "session-ranking-"));
const sessionsRoot = join(root, "sessions");
const alpha = join(sessionsRoot, ALPHA_DIR);
const alphaArchives = join(alpha, "archives");

const files = {};
try {
  await mkdir(alphaArchives, { recursive: true });

  // Q1 — dense archive vs many sparse live lines (occurrences vs lines).
  const dense = join(alpha, "2026-01-01T00-00-00-000Z_dense.jsonl");
  await writeFile(
    dense,
    [header(ALPHA_CWD), ...Array.from({ length: 12 }, (_, i) => userLine(`denseplanted note ${i}`))].join("\n") + "\n",
  );
  const denseArchive = join(alphaArchives, "01a0dense-1111-2222-3333-444444444444-1790000000000.jsonl");
  const denseOriginals = Array.from({ length: 30 }, (_, i) => rawUser(`archived denseplanted ${i}`));
  await writeFile(denseArchive, archiveEnvelope(denseOriginals) + "\n");
  await utimes(denseArchive, new Date(NOW), new Date(NOW));

  // Q2 — control token: live files only, one occurrence per line.
  const ctrl1 = join(alpha, "2026-09-28T00-00-00-000Z_ctrl1.jsonl");
  await writeFile(
    ctrl1,
    [header(ALPHA_CWD), ...Array.from({ length: 5 }, (_, i) => userLine(`controltoken ${i}`))].join("\n") + "\n",
  );
  const ctrl2 = join(alpha, "2026-09-28T00-00-00-001Z_ctrl2.jsonl");
  await writeFile(
    ctrl2,
    [header(ALPHA_CWD), ...Array.from({ length: 3 }, (_, i) => userLine(`controltoken ${i}`))].join("\n") + "\n",
  );
  const ctrl3 = join(alpha, "2026-09-27T00-00-00-000Z_ctrl3.jsonl");
  await writeFile(
    ctrl3,
    [header(ALPHA_CWD), ...Array.from({ length: 2 }, (_, i) => userLine(`controltoken ${i}`))].join("\n") + "\n",
  );

  // Q3 — recency: equal occurrences, dates carried by mtime (no date in the
  // name, so the pre-fix path tie-break can put the older file first).
  const recent = join(alpha, "arecent.jsonl");
  await writeFile(
    recent,
    [header(ALPHA_CWD), ...Array.from({ length: 4 }, (_, i) => userLine(`recencytoken ${i}`))].join("\n") + "\n",
  );
  await utimes(recent, new Date(NOW), new Date(NOW));
  const old = join(alpha, "zold.jsonl");
  await writeFile(
    old,
    [header(ALPHA_CWD), ...Array.from({ length: 4 }, (_, i) => userLine(`recencytoken ${i}`))].join("\n") + "\n",
  );
  await utimes(old, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

  Object.assign(files, { dense, denseArchive, ctrl1, ctrl2, ctrl3, recent, old });

  console.log("=== session-recall ranking ===\n");

  // ── (a) the four signals, each moving the order alone ──────────────────────
  await test("(a) occurrences: more matches outrank fewer, all else equal", () => {
    const ranked = rankSearchResults(
      [
        { path: `${alpha}/2026-09-29T00-00-00-000Z_a.jsonl`, count: 2, userHits: 2 },
        { path: `${alpha}/2026-09-29T00-00-00-000Z_b.jsonl`, count: 9, userHits: 9 },
      ],
      { now: NOW, currentProject: CURRENT_PROJECT },
    );
    assert.equal(basename(ranked[0].path), "2026-09-29T00-00-00-000Z_b.jsonl");
  });

  await test("(a) recency: newer session outranks older at equal occurrences", () => {
    const ranked = rankSearchResults(
      [
        { path: `${alpha}/2026-01-01T00-00-00-000Z_old.jsonl`, count: 5, userHits: 5 },
        { path: `${alpha}/2026-09-29T00-00-00-000Z_new.jsonl`, count: 5, userHits: 5 },
      ],
      { now: NOW, currentProject: CURRENT_PROJECT },
    );
    assert.equal(basename(ranked[0].path), "2026-09-29T00-00-00-000Z_new.jsonl");
  });

  await test("(a) project: same-project candidate outranks another project", () => {
    const ranked = rankSearchResults(
      [
        { path: `${sessionsRoot}/--Users-tester-beta--/2026-09-29T00-00-00-000Z_b.jsonl`, count: 5, userHits: 5 },
        { path: `${alpha}/2026-09-29T00-00-00-000Z_a.jsonl`, count: 5, userHits: 5 },
      ],
      { now: NOW, currentProject: CURRENT_PROJECT },
    );
    assert.equal(basename(ranked[0].path), "2026-09-29T00-00-00-000Z_a.jsonl");
  });

  await test("(a) role: a user-turn hit outranks the same hit in a tool result", () => {
    const ranked = rankSearchResults(
      [
        { path: `${alpha}/2026-09-29T00-00-00-000Z_tool.jsonl`, count: 6, userHits: 0 },
        { path: `${alpha}/2026-09-29T00-00-00-000Z_user.jsonl`, count: 6, userHits: 6 },
      ],
      { now: NOW, currentProject: CURRENT_PROJECT },
    );
    assert.equal(basename(ranked[0].path), "2026-09-29T00-00-00-000Z_user.jsonl");
  });

  // ── (b) RED: line count and occurrence count disagree ──────────────────────
  await test("(b) RED: pre-fix line-count order puts the dense archive below the live file", () => {
    const legacy = names(legacyRank(legacySearchFiles("denseplanted", alpha)).slice(0, 10));
    assert.deepEqual(legacy, [basename(dense), basename(denseArchive)]);
  });

  await test("(b) GREEN: the new order puts the dense archive above the live file", async () => {
    const matches = await searchFiles("denseplanted", alpha);
    const ranked = names(
      rankSearchResults(matches, { now: NOW, currentProject: CURRENT_PROJECT }).slice(0, 10),
    );
    assert.deepEqual(ranked, [basename(denseArchive), basename(dense)]);
    const archive = matches.find((m) => m.path === denseArchive);
    const live = matches.find((m) => m.path === dense);
    assert.ok(archive.count > live.count, "the archive must be denser in occurrences");
    assert.equal(live.count, 12, "live file: 12 occurrences across 12 lines");
    assert.equal(archive.count, 30, "archive: 30 occurrences on 1 line");
  });

  await test("(b) the first archive's rank strictly improves", async () => {
    const before = names(legacyRank(legacySearchFiles("denseplanted", alpha)));
    const after = names(
      rankSearchResults(await searchFiles("denseplanted", alpha), {
        now: NOW,
        currentProject: CURRENT_PROJECT,
      }),
    );
    const beforeRank = before.indexOf(basename(denseArchive));
    const afterRank = after.indexOf(basename(denseArchive));
    assert.ok(beforeRank > 0, "pre-fix the archive is not first");
    assert.equal(afterRank, 0, "post-fix the archive is first");
    assert.ok(afterRank < beforeRank, "rank must strictly improve");
  });

  // ── (c) control: live top-10 unchanged ─────────────────────────────────────
  await test("(c) control token: live top-10 order is unchanged", async () => {
    const before = names(legacyRank(legacySearchFiles("controltoken", alpha)).slice(0, 10));
    const after = names(
      rankSearchResults(await searchFiles("controltoken", alpha), {
        now: NOW,
        currentProject: CURRENT_PROJECT,
      }).slice(0, 10),
    );
    assert.deepEqual(before, after);
  });

  // ── (d) three fixed queries, pinned before/after top-10 ────────────────────
  await test("(d) three fixed queries: pinned before/after top-10 lists", async () => {
    const expected = [
      {
        query: "denseplanted",
        before: [basename(dense), basename(denseArchive)],
        after: [basename(denseArchive), basename(dense)],
      },
      {
        query: "controltoken",
        before: [basename(ctrl1), basename(ctrl2), basename(ctrl3)],
        after: [basename(ctrl1), basename(ctrl2), basename(ctrl3)],
      },
      {
        query: "recencytoken",
        before: [basename(old), basename(recent)],
        after: [basename(recent), basename(old)],
      },
    ];
    for (const { query, before, after } of expected) {
      const gotBefore = names(legacyRank(legacySearchFiles(query, alpha)).slice(0, 10));
      const gotAfter = names(
        rankSearchResults(await searchFiles(query, alpha), {
          now: NOW,
          currentProject: CURRENT_PROJECT,
        }).slice(0, 10),
      );
      assert.deepEqual(gotBefore, before, `${query}: before list drifted`);
      assert.deepEqual(gotAfter, after, `${query}: after list drifted`);
    }
  });

  // ── role must actually reach the fixture ───────────────────────────────────
  await test("(e) the role pass tags user-line hits on the fixture", async () => {
    const matches = await searchFiles("controltoken", alpha);
    const c1 = matches.find((m) => m.path === files.ctrl1);
    assert.equal(c1.userHits, 5, "five user lines carry the token");
  });

  if (!rankSearchResults) {
    throw new Error("rankSearchResults export missing — this build predates the ranking change");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

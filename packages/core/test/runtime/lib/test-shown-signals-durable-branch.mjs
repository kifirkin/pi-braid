/**
 * Shown-signal dedupe is branch-durable.
 *
 * Contract:
 * - the ACTIVE BRANCH decides what this session has already shown: two
 *   different synthetic branches reconstruct differently (the red-proof core);
 * - marks append a durable custom entry (`braid_shown_signal`) through the
 *   extension API's appendEntry seam, and those entries reconstruct to
 *   "shown" on the next session_start;
 * - the project-level disk file is a derived write-through index only: after
 *   a rewind to a branch that never saw the signal, the branch answers
 *   false even though the file recorded the mark (the old bug);
 * - malformed payloads are skipped; reconstruction is per-slug.
 *
 * BRAID_HOME pins the whole braid tree to a tmpdir so the write-through never
 * touches the live ~/.pi/agent/braid/shown-signals.json.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-durable-signals-"));

const {
  readShownSignalsFromBranch,
  reconstructShownSignalsFromBranch,
  isProjectSignalShown,
  markProjectSignalShown,
  SHOWN_SIGNAL_ENTRY_TYPE,
} = await import("../../../dist/lib/state/global-state.js");

const SLUG = "test-project-durable";

function signalEntry(slug, type, id = "s1") {
  return {
    type: "custom",
    customType: SHOWN_SIGNAL_ENTRY_TYPE,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    data: { slug, type, timestamp: Date.now() },
  };
}

/** Fake appendEntry seam: records what the extension API would persist. */
function fakeAppender() {
  const entries = [];
  return {
    entries,
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
}

function asBranch(entries) {
  return entries.map((e, i) => ({
    type: "custom",
    customType: e.customType,
    id: `e${i}`,
    parentId: null,
    data: e.data,
  }));
}

describe("shown-signals branch durability", () => {
  beforeEach(() => {
    reconstructShownSignalsFromBranch([]);
  });

  it("two synthetic branches reconstruct differently (red-proof core)", () => {
    const branchShown = [signalEntry(SLUG, "scratchpad_prior")];
    const branchNeverShown = [];

    reconstructShownSignalsFromBranch(branchShown);
    assert.equal(isProjectSignalShown(SLUG, "scratchpad_prior"), true);

    reconstructShownSignalsFromBranch(branchNeverShown);
    assert.equal(
      isProjectSignalShown(SLUG, "scratchpad_prior"),
      false,
      "the rewound branch never saw it; suppression must not survive the branch",
    );
  });

  it("reconstruction is per-slug", () => {
    reconstructShownSignalsFromBranch([signalEntry("other-project", "memory_prior")]);

    assert.equal(isProjectSignalShown(SLUG, "memory_prior"), false);
    assert.equal(isProjectSignalShown("other-project", "memory_prior"), true);
  });

  it("malformed entries are skipped, never trusted", () => {
    const map = readShownSignalsFromBranch([
      { type: "custom", customType: SHOWN_SIGNAL_ENTRY_TYPE, data: { slug: 42, type: "resume" } },
      { type: "custom", customType: SHOWN_SIGNAL_ENTRY_TYPE, data: null },
      { type: "custom", customType: "not_shown_signal", data: { slug: SLUG, type: "resume" } },
      { type: "message", customType: SHOWN_SIGNAL_ENTRY_TYPE, data: { slug: SLUG, type: "resume" } },
      signalEntry(SLUG, "resume", "valid"),
    ]);

    assert.equal(map.size, 1);
    assert.deepEqual([...map.get(SLUG)], ["resume"]);
  });

  it("mark appends a durable entry that reconstructs to shown", () => {
    const appender = fakeAppender();

    markProjectSignalShown(SLUG, "resume", appender);

    assert.equal(appender.entries.length, 1, "one durable entry per mark");
    assert.equal(appender.entries[0].customType, SHOWN_SIGNAL_ENTRY_TYPE);
    assert.equal(appender.entries[0].data.slug, SLUG);
    assert.equal(appender.entries[0].data.type, "resume");

    // Next session_start: the branch carries the entry, so it reconstructs.
    reconstructShownSignalsFromBranch(asBranch(appender.entries));
    assert.equal(isProjectSignalShown(SLUG, "resume"), true);
  });

  it("the disk file is a derived index: the branch decides after a rewind", () => {
    const appender = fakeAppender();

    markProjectSignalShown(SLUG, "tags_prior", appender);

    const indexFile = join(process.env.BRAID_HOME, "shown-signals.json");
    assert.equal(existsSync(indexFile), true, "write-through index exists");
    const index = JSON.parse(readFileSync(indexFile, "utf-8"));
    assert.ok(
      index[SLUG].includes("tags_prior"),
      "index records the project-level mark (accumulating across marks)",
    );

    // Rewind to a branch that never saw the signal: the index must not
    // suppress it (this was the bug - the file overrode the branch).
    reconstructShownSignalsFromBranch([]);
    assert.equal(isProjectSignalShown(SLUG, "tags_prior"), false);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../../../scripts/journal-append.mjs");

const entry = (seq) =>
  JSON.stringify({
    seq,
    at: "2026-01-01T00:00:00Z",
    kind: "outcome",
    subject: `archived-${seq}`,
    text: "an archived line, carried so the chain has a floor",
    reason: null,
    evidence: ["fixture"],
    supersedes: null,
    seat: { label: "seat", session: "fixture", revision: "none" },
  });

/**
 * Rotation moves a prefix out of the live file. The writer's sequence must
 * continue from the archive, not restart at one: a restart breaks the checker's
 * archive boundary (the archived last seq must sit below the live first seq),
 * and the boundary is the only rule that keeps two chains from interleaving.
 */
test("the writer continues the sequence across a rotated archive", () => {
  const home = mkdtempSync(join(tmpdir(), "journal-rotation-"));
  try {
    const dir = join(home, "journal", "fixture-slug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal-2026.jsonl"), `${entry(1)}\n${entry(2)}\n${entry(3)}\n`);
    writeFileSync(join(dir, "journal.jsonl"), "");

    const payload = join(home, "payload.json");
    writeFileSync(
      payload,
      JSON.stringify({
        kind: "decision",
        subject: "the-first-live-entry-after-a-rotation",
        text: "A live entry written after the prefix moved to the archive.",
        reason: "The archive's last number is the floor, so the chain never restarts.",
        evidence: ["fixture"],
      }),
    );

    const out = execFileSync("node", [script, "--cwd", home, "--project", "fixture-slug", "--file", payload], {
      env: { ...process.env, BRAID_HOME: home },
      encoding: "utf8",
    });
    const written = JSON.parse(out);
    assert.equal(written.seq, 4, "the first live entry continues the archived chain");

    const live = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(live.length, 1);
    assert.equal(live[0].seq, 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

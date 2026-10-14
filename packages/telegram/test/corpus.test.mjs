/**
 * corpus.test.mjs — node:test wrapper around test/corpus-runner.mjs. The
 * runner's assertions are: every wire chunk under Telegram's cap, every HTML
 * wire accepted by the local checker (no new rejection against the pre-wave
 * baseline), the recorded live verdicts agree with the checker, the 21-cell
 * resolution matrix is unchanged, the cap-crossing bodies keep their named
 * contract, and the fidelity-change set equals the named list. NO network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runCorpus, runHtmlParseCorpus } from "./corpus-runner.mjs";

test("corpus: every replay invariant holds (wire validity, baseline fidelity, caps, matrix)", async () => {
  const report = await runCorpus();
  assert.deepEqual(
    report.failures,
    [],
    `corpus violations:\n${report.failures.join("\n")}`,
  );
  assert.equal(report.counts.hostileCases, 76);
  assert.equal(report.counts.matrixCells, 21);
  assert.ok(report.counts.htmlWires > 0);
});

test("corpus: the checker agrees with every recorded live HTML parse verdict", () => {
  const report = runHtmlParseCorpus();
  assert.deepEqual(
    report.failures,
    [],
    `checker/live disagreements:\n${report.failures.join("\n")}`,
  );
  assert.equal(report.cases, 87);
});

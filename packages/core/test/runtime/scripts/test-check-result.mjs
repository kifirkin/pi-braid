#!/usr/bin/env node
// test-check-result.mjs — offline harness for check-result.mjs.
//
// Every repository a case needs is a temp fixture this file builds, so no
// verdict depends on a checkout that happens to exist on the machine running
// it. The gate's default repository set is exercised by pointing a fixture at
// `$PWD` or by asking which checkout the gate itself lives in; no case names a
// real one.
//
// Synthetic session fixtures (one assistant message carrying one fenced result
// block) cover the source-revision leg: a block without the field and a block
// with a malformed value exit 1; a well-formed sha that resolves in the fixture
// repo passes and names the repo it resolved in; a well-formed sha no repo
// resolves passes with a WARN line naming every repo tried. The block is
// otherwise valid in every case, so each verdict is attributable to the
// source-revision leg alone — each failing case must carry exactly one FAIL
// line. A session with no block still exits 2, the no-schema code. Section (h)
// covers the instrument-capability pairing read: it is warn-only, so every case
// there asserts exit 0 and reads the WARN claim-capability lines and the counter
// line instead of a refusal.
//
// The gate under test defaults to the script three directories up;
// CHECK_RESULT=<path> overrides it, which is how a RED run is recorded against a
// pre-change copy. BRAID_GATE_REPOS defaults to the fixture repo, so the default
// search path is what most cases exercise.
//
// Section (o) covers claim–row parity: a claim that names a runnable file must
// have a row naming the same file, and a `completed` block's row must exit 0.
// Its cases build the citation and the row explicitly rather than relying on the
// baseline block, whose verifier names no file so that every other case isolates
// one leg.

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK_RESULT =
  process.env.CHECK_RESULT ||
  join(import.meta.dirname, "..", "..", "..", "scripts", "check-result.mjs");

const root = mkdtempSync(join(tmpdir(), "check-result-test-"));
const outputFile = join(root, "report.md");
writeFileSync(outputFile, "# fixture report\n\n## Placement\n\nfixture only\n");

// ── the fixture repository every resolve case reads ──────────────────────────
// Two commits on the main line and one on a side branch, so "this is HEAD",
// "the tree moved", "the revision never landed" and the tracked-entry census
// are all expressible without touching a real checkout.
const fixtureRepo = join(root, "fixture-repo");
const fx = (...args) => spawnSync("git", ["-C", fixtureRepo, ...args], { encoding: "utf8" });
spawnSync("git", ["init", "-q", "-b", "main", fixtureRepo]);
fx("config", "user.email", "fixture@example.test");
fx("config", "user.name", "fixture");
writeFileSync(join(fixtureRepo, "first.txt"), "one\n");
fx("add", "-A");
fx("commit", "-q", "-m", "first");
const fixtureFirst = fx("rev-parse", "HEAD").stdout.trim();
writeFileSync(join(fixtureRepo, "second.txt"), "two\n");
fx("add", "-A");
fx("commit", "-q", "-m", "second");
const fixtureHead = fx("rev-parse", "HEAD").stdout.trim();
fx("checkout", "-q", "-b", "side");
writeFileSync(join(fixtureRepo, "side.txt"), "side\n");
fx("add", "-A");
fx("commit", "-q", "-m", "side");
const fixtureSide = fx("rev-parse", "HEAD").stdout.trim();
fx("checkout", "-q", "main");
/** Entries the fixture repo tracks at a revision: the census a stamp names. */
const fixtureCensus = fx("ls-tree", "-r", "--name-only", fixtureHead)
  .stdout.split("\n")
  .filter(Boolean).length;
/** The checkout holding the gate, when the gate is inside one (a copy-out is not). */
const gateCheckout = spawnSync(
  "git",
  ["-C", join(CHECK_RESULT, ".."), "rev-parse", "--show-toplevel"],
  { encoding: "utf8" },
);
const gateCheckoutRoot = gateCheckout.status === 0 ? gateCheckout.stdout.trim() : "";
/** Well-formed and resolvable nowhere: the shape every "isolate another leg" case uses. */
const ghost = "0123456789abcdef0123456789abcdef01234567";
/** Resolves through BRAID_GATE_REPOS, so a case can isolate some other leg. */
const settled = fixtureHead;


let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function makeSession(file, payload) {
  const path = join(root, file);
  const text =
    payload === null
      ? "No result block in this message."
      : `Result follows.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
  const entry = { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
  writeFileSync(path, `${JSON.stringify(entry)}\n`);
  return path;
}

function block(extra = {}) {
  return {
    worker: "fixture-worker",
    spec: "impl",
    status: "completed",
    output_file: outputFile,
    artifacts: [],
    gate_evidence: [{ cmd: "true", exit_code: 0 }],
    claims: [
      {
        claim: "fixture claim holds",
        // Names no runnable file: the cases below isolate one leg each, and a
        // baseline that cited a test would make every one of them a parity case
        // too. The parity leg has its own section, where each case builds the
        // citation and the row it needs.
        verified_by: "the fixture harness (offline, one assistant message per case)",
        predicts: "the gate exits 0 for a well-formed block",
      },
    ],
    ...extra,
  };
}

function run(session, extraArgs = [], opts = {}) {
  const r = spawnSync(process.execPath, [opts.checkResult ?? CHECK_RESULT, session, ...extraArgs], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: {
      ...process.env,
      // The default search path names the fixture repo, so a case that tests
      // something else does not first have to make its revision resolvable.
      BRAID_GATE_REPOS: fixtureRepo,
      ...opts.env,
    },
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const failLines = (stdout) => (stdout.match(/^FAIL/gm) || []).length;

console.log(`validator under test: ${CHECK_RESULT}\n`);

// ── (a) the field is required ────────────────────────────────────────────────

let r = run(makeSession("missing.jsonl", block()));
check(
  "(a) a block without source_revision exits 1 on that leg alone",
  r.code === 1 && failLines(r.stdout) === 1 && /FAIL\s+source-revision/.test(r.stdout) && /missing or empty/.test(r.stdout),
  `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
);

// ── (b) malformed values are rejected ────────────────────────────────────────

for (const [label, value] of [
  ["too short", "abc123"],
  ["not hex", "zzzzzzzz"],
  ["empty string", ""],
  ["null", null],
]) {
  const s = makeSession(`malformed-${label.replace(/ /g, "-")}.jsonl`, block({ source_revision: value }));
  r = run(s);
  check(
    `(b) ${label} source_revision exits 1`,
    r.code === 1 && failLines(r.stdout) === 1 && /FAIL\s+source-revision/.test(r.stdout),
    `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
  );
}

// ── (c) a resolvable sha passes and names the repo ────────────────────────
// Two forms of the same commit: the full sha and a 12-char prefix. The label
// asserted is the one the gate printed, which is the fixture path it resolved
// in, so the case also pins that a resolution names its repository.

for (const [label, sha] of [
  ["full", fixtureHead],
  ["short", fixtureHead.slice(0, 12)],
]) {
  r = run(makeSession(`head-${label}.jsonl`, block({ source_revision: sha })), ["--repo", fixtureRepo]);
  check(
    `(c) ${label} sha resolves in the named repo and the check names it`,
    r.code === 0 && /RESULT: PASS/.test(r.stdout) && r.stdout.includes(`source-revision  (resolved in ${fixtureRepo})`),
    `exit=${r.code} sha=${sha.slice(0, 12)}`,
  );
}

// The default search path, without --repo: $PWD is tried, so running the gate
// from inside the working tree resolves that tree's own revision.
r = run(makeSession("pwd-resolves.jsonl", block({ source_revision: fixtureHead })), [], {
  cwd: fixtureRepo,
  env: { BRAID_GATE_REPOS: "" },
});
check(
  "(c) with no --repo the revision resolves through $PWD",
  r.code === 0 && r.stdout.includes("source-revision  (resolved in $PWD)"),
  `exit=${r.code}`,
);

// The gate's own checkout is a default too, and only when the gate is inside
// one: the same run from a copy outside any work tree names $PWD and nothing
// else, which is what a copied-out single file has to say about itself.
if (gateCheckoutRoot !== "") {
  r = run(makeSession("own-checkout.jsonl", block({ source_revision: ghost })), [], {
    cwd: root,
    env: { BRAID_GATE_REPOS: "" },
  });
  const sourceFail = r.stdout.split("\n").find((l) => l.startsWith("FAIL") && l.includes("source-revision"));
  check(
    "(c) the gate names the checkout it lives in",
    r.code === 1 && Boolean(sourceFail) && sourceFail.includes("this checkout"),
    `exit=${r.code} checkout=${gateCheckoutRoot}`,
  );
  const copyDir = join(root, "copied-gate");
  mkdirSync(copyDir, { recursive: true });
  spawnSync("cp", [CHECK_RESULT, join(copyDir, "check-result.mjs")]);
  const copySession = makeSession("own-checkout-copy.jsonl", block({ source_revision: ghost }));
  const copied = spawnSync(process.execPath, [join(copyDir, "check-result.mjs"), copySession], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, BRAID_GATE_REPOS: "" },
  });
  const copyFail = (copied.stdout || "").split("\n").find((l) => l.startsWith("FAIL") && l.includes("source-revision"));
  check(
    "(c) a copy outside any work tree names no checkout (control)",
    copied.status === 1 && Boolean(copyFail) && !copyFail.includes("this checkout"),
    `exit=${copied.status}`,
  );
} else {
  console.log("SKIP  (c) the gate is not inside a work tree here; the own-checkout default cannot be exercised");
}

// ── (d) well-formed but unresolvable passes with a WARN ──────────────────
// The block names a sha no repository holds. Shape is not evidence: a revision
// that exists nowhere attests no tree, so it is a refusal now, not a warning.
// The refusal has to be usable as well: it names the revision, every label the
// gate tried, and the remedy. The expected labels are computed from what was
// actually passed in, so a case cannot agree with a hardcoded order.

const otherRepos = [join(root, "repo-b"), join(root, "repo-c")];
for (const dir of otherRepos) {
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "fixture"]);
}

r = run(makeSession("ghost.jsonl", block({ source_revision: ghost })), ["--repo", otherRepos[0]], {
  cwd: root,
  env: { BRAID_GATE_REPOS: otherRepos[1] },
});
const sourceFail = r.stdout.split("\n").find((l) => l.startsWith("FAIL") && l.includes("source-revision"));
const expectedTried = [...otherRepos, "$PWD"];
if (gateCheckoutRoot !== "") expectedTried.push("this checkout");
check(
  "(d) an unresolvable sha is refused, not accepted on shape",
  r.code === 1 && failLines(r.stdout) === 1 && Boolean(sourceFail),
  `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
);
check(
  "(d) the refusal names the revision, every repo tried, and why",
  Boolean(sourceFail) &&
    sourceFail.includes(ghost) &&
    expectedTried.every((label) => sourceFail.includes(label)) &&
    /cannot attest/.test(sourceFail) &&
    /--repo/.test(sourceFail),
  `detail=${sourceFail ? sourceFail.slice(0, 110) : "absent"}`,
);
check(
  "(d) the refusal names only repos that were searched (control)",
  Boolean(sourceFail) && !sourceFail.includes(join(root, "repo-never-tried")),
  `detail=${sourceFail ? sourceFail.slice(0, 60) : "absent"}`,
);

// ── (e) a verifier that names no instrument is refused ───────────────────────
// The decidable half of the unverified-claim class: a bare weasel word, a
// weasel word with filler, or a string too short to name anything. Measured
// over the 607 claims already in the ledger this refuses 1 (0.2%) - the one
// instance that named no instrument at all - so the rule is sharp rather than
// a flood, and the prose-but-unsourced residue stays a WARN.

const weaselCases = [
  ["bare-word", "test"],
  ["weasel-plus-filler", "read the file"],
  ["too-short", "ok"],
];
for (const [name, verifiedBy] of weaselCases) {
  const b = block({ source_revision: settled }); // resolves through the env, so the claims leg is the only FAIL
  b.claims[0].verified_by = verifiedBy;
  const rr = run(makeSession(`weasel-${name}.jsonl`, b));
  check(
    `(e) verified_by ${name} (${JSON.stringify(verifiedBy)}) exits 1 on that leg alone`,
    rr.code === 1 && failLines(rr.stdout) === 1 && /FAIL\s+claims-verified-by-names/.test(rr.stdout),
    `exit=${rr.code} fail-lines=${failLines(rr.stdout)}`,
  );
}

// A verifier that names a command or a path passes the same leg.
for (const [name, verifiedBy] of [["command", "npm test -w packages/telegram"], ["path", "packages/telegram/test/index.test.mjs:2246"], ["quoted-absence", "no check exists; stated as an absence in the report"]] ) {
  const b = block({ source_revision: settled });
  b.claims[0].verified_by = verifiedBy;
  const rr = run(makeSession(`verifier-${name}.jsonl`, b));
  check(
    `(e) verified_by naming ${name} does not fail that leg`,
    !/FAIL\s+claims-verified-by-names/.test(rr.stdout),
    `exit=${rr.code}${/WARN claims-verified-by-names/.test(rr.stdout) ? " (warned)" : ""}`,
  );
}

// ── (f) a close's own repository can be named, so its revision resolves ─────
// A block whose revision lives outside the gate's default search set is refused;
// the same sha resolves when the caller names the repo, which is the whole point
// of --repo: the revision is checkable, the gate just has to be told where.

if (fixtureHead) {
  const without = run(makeSession("foreign-without.jsonl", block({ source_revision: fixtureHead })), [], {
    cwd: root,
    env: { BRAID_GATE_REPOS: "" },
  });
  check(
    "(f) without --repo a revision no default holds is refused",
    without.code === 1 && /FAIL\s+source-revision/.test(without.stdout),
    `exit=${without.code}`,
  );
  const withRepo = run(
    makeSession("foreign-with.jsonl", block({ source_revision: fixtureHead })),
    ["--repo", fixtureRepo],
    { cwd: root, env: { BRAID_GATE_REPOS: "" } },
  );
  check(
    "(f) with --repo the same revision resolves and the label names the repo",
    withRepo.code === 0 && /resolved in /.test(withRepo.stdout) && !/WARN source-revision:/.test(withRepo.stdout),
    `exit=${withRepo.code} ${(withRepo.stdout.split("\n").find((l) => /source-revision/.test(l)) || "").trim().slice(0, 70)}`,
  );
} else {
  console.log("SKIP  (f) the fixture repo could not be created here");
}

// ── (g) the population-scan stamp contract ──────────────────────────────────
// A row whose command carries a walk/list/count verb is a population scan, and
// any row whose stamp is present but unreadable carries no record either. The
// tier keys on the block's claim: a completed block is refused, because the
// merge path compares that record against the census the revision it names
// holds, and a row it cannot read is a number nothing can test; an incomplete
// block keeps the warning. The counter line is the measurement surface in both
// tiers, and the grammar is quoted by the refusal.

const stampWarn = (stdout) => stdout.split("\n").filter((l) => l.startsWith("WARN gate-evidence stamp:"));
const stampFail = (stdout) => stdout.split("\n").filter((l) => l.startsWith("FAIL gate-evidence-stamps:"));
const counterLine = (stdout) => stdout.split("\n").find((l) => l.startsWith("gate-evidence-stamps:"));
const withGates = (rows, extra = {}) => block({ source_revision: settled, gate_evidence: rows, ...extra });

r = run(makeSession("scan-unstamped.jsonl", withGates([{ cmd: "git ls-files | wc -l", exit: 0 }])));
check(
  "(g) a completed block with a recognized scan row and no stamp is REFUSED",
  r.code === 1 &&
    stampFail(r.stdout).length === 1 &&
    /row 0/.test(stampFail(r.stdout)[0]) &&
    /scanned <n> <unit> at <revision>/.test(stampFail(r.stdout)[0]) &&
    /ONE lowercase word/.test(stampFail(r.stdout)[0]) &&
    counterLine(r.stdout) === "gate-evidence-stamps: 0/1 recognized scan row(s) carry a parseable stamp",
  `exit=${r.code} fail=${stampFail(r.stdout)[0]?.slice(0, 90) ?? "absent"} counter=${counterLine(r.stdout) ?? "absent"}`,
);
check(
  "(g) the refused row still prints its own named line, so the reader sees which row",
  stampWarn(r.stdout).length === 1 && /row 0/.test(stampWarn(r.stdout)[0]) && /population scan/.test(stampWarn(r.stdout)[0]),
  `warn=${stampWarn(r.stdout)[0]?.slice(0, 80) ?? "absent"}`,
);

// The tier boundary: the same row in a block that does not claim completion is
// a warning, and the counter still prints.
r = run(
  makeSession(
    "scan-unstamped-partial.jsonl",
    withGates([{ cmd: "git ls-files | wc -l", exit: 0 }], { status: "partial" }),
  ),
);
check(
  "(g) the same row under status=partial warns and the block stays valid (control)",
  r.code === 0 &&
    /RESULT: PASS/.test(r.stdout) &&
    stampWarn(r.stdout).length === 1 &&
    stampFail(r.stdout).length === 0 &&
    counterLine(r.stdout) === "gate-evidence-stamps: 0/1 recognized scan row(s) carry a parseable stamp",
  `exit=${r.code} warn=${stampWarn(r.stdout).length} fail=${stampFail(r.stdout).length}`,
);

r = run(
  makeSession(
    "scan-stamped.jsonl",
    withGates([{ cmd: "git ls-files | wc -l", exit: 0, stamp: "scanned 12 files at abc1234" }]),
  ),
);
check(
  "(g) a recognized scan row with a parseable stamp is silent and counted",
  r.code === 0 &&
    stampWarn(r.stdout).length === 0 &&
    counterLine(r.stdout) === "gate-evidence-stamps: 1/1 recognized scan row(s) carry a parseable stamp",
  `exit=${r.code} counter=${counterLine(r.stdout) ?? "absent"}`,
);

r = run(makeSession("scan-unrecognized.jsonl", withGates([{ cmd: "npm run ci:check", exit: 0 }])));
check(
  "(g) an unrecognized command with no stamp is not a scan and does not warn",
  r.code === 0 && stampWarn(r.stdout).length === 0 && counterLine(r.stdout) === undefined,
  `exit=${r.code} counter=${counterLine(r.stdout) ?? "absent"}`,
);

r = run(
  makeSession(
    "scan-wrapper.jsonl",
    withGates([{ cmd: "node packages/core/scripts/check-placement.mjs --strict", exit: 0 }]),
  ),
);
check(
  "(g) a wrapper whose walk is inside the script stays a miss (no project vocabulary)",
  r.code === 0 && stampWarn(r.stdout).length === 0 && counterLine(r.stdout) === undefined,
  `exit=${r.code} counter=${counterLine(r.stdout) ?? "absent"}`,
);

r = run(
  makeSession(
    "scan-unreadable.jsonl",
    withGates([{ cmd: "node count.mjs", exit: 0, stamp: "scanned twelve files" }]),
  ),
);
check(
  "(g) an unreadable stamp in a completed block is REFUSED and the row is named",
  r.code === 1 &&
    stampWarn(r.stdout).length === 1 &&
    /row 0/.test(stampWarn(r.stdout)[0]) &&
    /unparseable stamp: "scanned twelve files"/.test(stampWarn(r.stdout)[0]) &&
    /expected "scanned <n> <unit> at <revision>"/.test(stampWarn(r.stdout)[0]) &&
    stampFail(r.stdout).length === 1,
  `exit=${r.code} warn=${stampWarn(r.stdout)[0]?.slice(0, 90) ?? "absent"}`,
);

// The shape this grammar exists for: a unit that is a phrase. `in <path>` inside
// the stamp is the one this machine actually recorded, and the rule that refuses
// it is the unit, not the revision.
const phraseStamp = "scanned 42 tests in packages/telegram at 130129c";
r = run(
  makeSession("scan-phrase-unit.jsonl", withGates([{ cmd: "npm test -w packages/telegram", exit: 0, stamp: phraseStamp }])),
);
check(
  "(g) a stamp whose unit is a phrase is refused, and the refusal states the unit rule",
  r.code === 1 &&
    /scanned 42 tests in packages\/telegram at 130129c/.test(r.stdout) &&
    /ONE lowercase word/.test(stampFail(r.stdout)[0] ?? ""),
  `exit=${r.code} fail=${stampFail(r.stdout)[0]?.slice(0, 100) ?? "absent"}`,
);
r = run(
  makeSession("scan-phrase-unit-fixed.jsonl", withGates([{ cmd: "npm test -w packages/telegram", exit: 0, stamp: "scanned 42 tests at 130129c" }])),
);
check(
  "(g) the same row with one word for its unit passes (the repair)",
  r.code === 0 && stampFail(r.stdout).length === 0 && /RESULT: PASS/.test(r.stdout),
  `exit=${r.code} counter=${counterLine(r.stdout) ?? "absent"}`,
);

r = run(
  makeSession("scan-nonstring.jsonl", withGates([{ cmd: "ls -la", exit: 0, stamp: 12 }])),
);
check(
  "(g) a non-string stamp is unreadable, named, and refused in a completed block",
  r.code === 1 &&
    stampWarn(r.stdout).length === 1 &&
    /unparseable stamp: 12/.test(stampWarn(r.stdout)[0]) &&
    stampFail(r.stdout).length === 1,
  `exit=${r.code} warn=${stampWarn(r.stdout)[0]?.slice(0, 70) ?? "absent"}`,
);

const recognizedVerbs = [
  "ls -la",
  "find . -type f",
  "fd -e mjs",
  "git ls-files",
  "git ls-tree -r --name-only main",
  "wc -l base.txt",
  "rg -n pattern .",
  "grep -rn pattern .",
];
const unrecognizedCommands = [
  "npm run ci:check",
  "npx tsc --noEmit",
  "true",
  "git diff --stat",
  "node scripts/check-doc-status.mjs",
];
for (const cmd of recognizedVerbs) {
  const rr = run(makeSession(`verb-${cmd.replace(/\W+/g, "-")}.jsonl`, withGates([{ cmd, exit: 0 }])));
  check(
    `(g) verb shape recognized and refused when unstamped: ${cmd}`,
    rr.code === 1 && stampWarn(rr.stdout).length === 1 && stampFail(rr.stdout).length === 1,
    `exit=${rr.code} warns=${stampWarn(rr.stdout).length}`,
  );
}
for (const cmd of unrecognizedCommands) {
  const rr = run(makeSession(`noverb-${cmd.replace(/\W+/g, "-")}.jsonl`, withGates([{ cmd, exit: 0 }])));
  check(
    `(g) verb shape unrecognized: ${cmd}`,
    rr.code === 0 && stampWarn(rr.stdout).length === 0 && counterLine(rr.stdout) === undefined,
    `exit=${rr.code} warns=${stampWarn(rr.stdout).length}`,
  );
}

r = run(
  makeSession(
    "scan-mixed.jsonl",
    withGates([
      { cmd: "git ls-files | wc -l", exit: 0 },
      { cmd: "wc -l base.txt", exit: 0, stamp: "scanned 3 rows at abc1234" },
      { cmd: "npm run ci:check", exit: 0 },
    ]),
  ),
);
check(
  "(g) the counter reports recognized-rows-stamped over recognized rows, and one row is refused",
  r.code === 1 &&
    stampWarn(r.stdout).length === 1 &&
    /row 0/.test(stampWarn(r.stdout)[0]) &&
    /row 0/.test(stampFail(r.stdout)[0] ?? "") &&
    counterLine(r.stdout) === "gate-evidence-stamps: 1/2 recognized scan row(s) carry a parseable stamp",
  `exit=${r.code} counter=${counterLine(r.stdout) ?? "absent"}`,
);

// ── (h) the instrument-capability pairing read (D3/D4) ──────────────────────
// Warn tier only: a warned pair asserts a property its verifier's shape cannot
// observe, and the block stays valid (exit 0) whatever the read finds. The
// table covers each rule in both directions, the D4 elimination clause with
// and without a census, a verifier the registry cannot classify in each
// asserted class (no warn: that residue is the seat's re-derivation job), and
// the T6 fabricated-number block as the zero point — the registry must not
// claim to catch it.

const capabilityWarnLines = (stdout) => stdout.split("\n").filter((l) => l.startsWith("WARN claim-capability:"));
const capabilityCounterLine = (stdout) => stdout.split("\n").find((l) => l.startsWith("claim-capability:"));
const claimFixture = (claim, verifiedBy) =>
  block({
    source_revision: settled,
    claims: [{ claim, verified_by: verifiedBy, predicts: "re-running the cited instrument exits 0 and prints its evidence" }],
  });

const capabilityCases = [
  ["coverage on a search/count verb warns (D4)", "the stale reader is gone from the tree", "rg 'stale-reader' src/ (0 hits)", ["coverage-on-search"]],
  ["elimination on a search verb warns (D4)", "no remaining callers of the old probe", "grep -rn 'old-probe' packages/", ["coverage-on-search"]],
  ["elimination on a census does not warn", "the stale reader is gone from the tree", "git ls-files '*.mjs' | wc -l; the census carries no reader", []],
  ["elimination on a suite run does not warn", "no remaining callers of the old probe", "npm test -w packages/core (suite run, 0 failures)", []],
  ["coverage on a content read does not warn", "the legacy entry is removed", "read src/legacy.mjs: 0 bytes; the file is empty", []],
  ["coverage on an execution verb does not warn (the strict tier's bound)", "the old boot path is gone", "node -e 'process.exit(0)' (exits 0)", []],
  ["content on a citation warns (D3)", "the file contains 330 entries", "the report's description of the artifact", ["content-on-citation"]],
  ["content on a content verb does not warn", "the artifact contains 120 bytes", "stat artifact.md: 120 bytes on disk", []],
  ["content on citation plus a read does not warn", "the file contains 12 entries", "report description plus read; 12 entries", []],
  ["classification on a bare count warns (D3)", "only the private rows remain", "rg -c 'row' rows.txt (24 hits)", ["classification-on-bare-count"]],
  ["classification on a decomposed count does not warn", "only the private rows remain; the count decomposes by source", "rg -c 'row' rows.txt (24 hits)", []],
  ["classification on a decomposed verifier does not warn", "the leak class is private", "wc -l hits.txt (24 hits; broken down by source)", []],
  ["classification on a content verifier does not warn", "the leak class is private", "read leak.mjs; inspected the classes", []],
  ["a description claim on a citation does not warn (no rule pairs descriptions)", "the helper is a stub", "the report's description of the helper", []],
];

for (const [label, claim, verifiedBy, expected] of capabilityCases) {
  const rr = run(makeSession(`cap-${label.replace(/\W+/g, "-").slice(0, 40)}.jsonl`, claimFixture(claim, verifiedBy)));
  const warns = capabilityWarnLines(rr.stdout);
  const counter = capabilityCounterLine(rr.stdout) ?? "";
  const rulesOk =
    warns.length === expected.length &&
    warns.every((l, i) => l.includes(`[${expected[i]}]`) && /claim 0/.test(l) && /asserted \S+/.test(l) && /observed through/.test(l));
  check(
    `(h) ${label}`,
    rr.code === 0 && /RESULT: PASS/.test(rr.stdout) && rulesOk && counter.startsWith(`claim-capability: 1/1 checked, ${expected.length} warn(s)`),
    `exit=${rr.code} warns=${warns.length} counter=${counter.slice(0, 60)}`,
  );
}

r = run(
  makeSession(
    "cap-multi.jsonl",
    block({
      source_revision: settled,
      claims: [
        { claim: "the file contains 330 entries", verified_by: "the report's description of the artifact", predicts: "the report cites the entry count as 330 -> entries = 330" },
        { claim: "the stale reader is gone", verified_by: "rg 'stale-reader' src/", predicts: "rg prints no line -> zero hits" },
      ],
    }),
  ),
);
check(
  "(h) two warned claims are named by index and counted per class",
  r.code === 0 &&
    /RESULT: PASS/.test(r.stdout) &&
    capabilityWarnLines(r.stdout).length === 2 &&
    capabilityWarnLines(r.stdout).some((l) => /claim 0 \[content-on-citation\]/.test(l)) &&
    capabilityWarnLines(r.stdout).some((l) => /claim 1 \[coverage-on-search\]/.test(l)) &&
    (capabilityCounterLine(r.stdout) ?? "").includes("2/2 checked, 2 warn(s)") &&
    (capabilityCounterLine(r.stdout) ?? "").includes("coverage-on-search 1, content-on-citation 1, classification-on-bare-count 0"),
  `exit=${r.code} warns=${capabilityWarnLines(r.stdout).length} counter=${(capabilityCounterLine(r.stdout) ?? "absent").slice(0, 80)}`,
);

// A verifier naming no registry class leaves the pairing read undecidable and
// silent (the design's refusal tier would cover it, and that tier is closed).
for (const [cls, claim] of [
  ["coverage", "the stale reader is gone from the tree"],
  ["content", "the file contains 9 entries"],
  ["classification", "the leak class is private"],
]) {
  const rr = run(makeSession(`cap-unpinned-${cls}.jsonl`, claimFixture(claim, "the fixture's own prose attestation")));
  check(
    `(h) an unpinned verifier on a ${cls} claim warns nothing for capability reasons`,
    rr.code === 0 &&
      /RESULT: PASS/.test(rr.stdout) &&
      capabilityWarnLines(rr.stdout).length === 0 &&
      (capabilityCounterLine(rr.stdout) ?? "").startsWith("claim-capability: 1/1 checked, 0 warn(s)"),
    `exit=${rr.code} warns=${capabilityWarnLines(rr.stdout).length}`,
  );
}

// The fabricated-number block from the instrument-registry dry run: schema-valid,
// one fabricated count. It must keep passing with no capability warn — the
// registry reads instrument shapes, not numbers.
r = run(
  makeSession(
    "cap-t6-zero-point.jsonl",
    block({
      source_revision: settled,
      // The claim cites this instrument, so the close records its run: the block
      // is a zero point for the capability read, not an exemption from parity.
      gate_evidence: [{ cmd: "node scripts/check-self-review.mjs", exit: 0 }],
      spec: "audit",
      claims: [
        {
          claim: "check-self-review.mjs at revision 22f945ae reports 999 passing checks and zero failures",
          verified_by: "node scripts/check-self-review.mjs",
          predicts: "output contains 999 lines beginning with PASS -> count of PASS lines = 999",
        },
      ],
    }),
  ),
);
check(
  "(h) the T6 fabricated-number block passes and warns nothing for capability reasons (zero point)",
  r.code === 0 &&
    /RESULT: PASS/.test(r.stdout) &&
    capabilityWarnLines(r.stdout).length === 0 &&
    (capabilityCounterLine(r.stdout) ?? "").startsWith("claim-capability: 1/1 checked, 0 warn(s)"),
  `exit=${r.code} warns=${capabilityWarnLines(r.stdout).length} counter=${(capabilityCounterLine(r.stdout) ?? "absent").slice(0, 60)}`,
);

// ── exit-code discipline: no block is exit 2 ─────────────────────────────────

r = run(makeSession("none.jsonl", null));
check("a session with no result block exits 2", r.code === 2, `exit=${r.code}`);

// ── (i) source-revision-freshness: drift is named, and --strict-staleness is fatal ──
// The fixture repo's first commit is one file behind its HEAD, so "the artifact's
// revision" and "HEAD" differ by a known file and the moved count is a fact this
// file can state rather than a number read from somewhere else.

const driftSession = makeSession("drift.jsonl", block({ source_revision: fixtureFirst }));
const relaxed = run(driftSession, ["--repo", fixtureRepo]);
check(
  "(i1) drift stays report-only by default, and the moved count is named in the transcript",
  relaxed.code === 0 && /moved:\s+\d+ file\(s\) since/.test(relaxed.stdout) && /PASS {2}source-revision-freshness/.test(relaxed.stdout),
  `exit=${relaxed.code}`,
);

const strictDrift = run(driftSession, ["--repo", fixtureRepo, "--strict-staleness"]);
check(
  "(i2) --strict-staleness turns the same drift into a failure that names the moved scope",
  strictDrift.code === 1 && /FAIL {2}source-revision-freshness/.test(strictDrift.stdout) && /FAIL \(--strict\): the artifact's scope moved/.test(strictDrift.stdout),
  `exit=${strictDrift.code}`,
);

const atHead = run(makeSession("at-head.jsonl", block({ source_revision: fixtureHead })), ["--repo", fixtureRepo, "--strict-staleness"]);
check(
  "(i3) a revision that IS HEAD passes even under --strict-staleness (the control)",
  atHead.code === 0 && /PASS {2}source-revision-freshness/.test(atHead.stdout),
  `exit=${atHead.code}`,
);

// The shape every close actually has: the block names its OWN commit, which is
// not in HEAD until it is merged. This case is what the first real close exposed:
// with it missing, the gate failed a correct block.
const unmergedSession = makeSession("unmerged.jsonl", block({ source_revision: fixtureSide }));
const unmergedRelaxed = run(unmergedSession, ["--repo", fixtureRepo]);
check(
  "(i4) an unmerged side-branch commit passes in report-only mode and the fact is stated",
  unmergedRelaxed.code === 0 && /PASS {2}source-revision-freshness/.test(unmergedRelaxed.stdout) && /unmerged or foreign revision/.test(unmergedRelaxed.stdout),
  `exit=${unmergedRelaxed.code}`,
);

const unmergedStrict = run(unmergedSession, ["--repo", fixtureRepo, "--strict-staleness"]);
check(
  "(i5) the same unmerged commit FAILS under --strict-staleness (consuming it as landed evidence)",
  unmergedStrict.code === 1 && /FAIL {2}source-revision-freshness/.test(unmergedStrict.stdout),
  `exit=${unmergedStrict.code}`,
);

// ── (j) red-evidence pairing: a RED row needs a build row beside it ─────────
//
// A planted revert reported from a tree that was never compiled is a RED for
// the wrong reason, and the class has re-entered this ledger three times. The
// read is warn-tier, so every case here asserts exit 0 and reads the WARN and
// counter lines rather than a refusal.

const redBuildWarn = (stdout) =>
  stdout.split("\n").filter((l) => l.startsWith("WARN gate-evidence red-build:"));
const redBuildCounter = (stdout) =>
  stdout.split("\n").find((l) => l.startsWith("gate-evidence-red-build:"));

r = run(
  makeSession(
    "red-unpaired.jsonl",
    withGates([{ cmd: "revert src/extensions/foo.ts, then node test-foo.mjs", exit: 1 }]),
  ),
);
check(
  "(j1) a red row with no build row warns and counts 0/1",
  r.code === 0 &&
    redBuildWarn(r.stdout).length === 1 &&
    /no build or typecheck row/.test(redBuildWarn(r.stdout)[0]) &&
    redBuildCounter(r.stdout) === "gate-evidence-red-build: 0/1 red row(s) paired with a build row",
  `exit=${r.code} warn=${redBuildWarn(r.stdout)[0]?.slice(0, 70) ?? "absent"} counter=${redBuildCounter(r.stdout) ?? "absent"}`,
);

r = run(
  makeSession(
    "red-paired.jsonl",
    withGates([
      { cmd: "revert src/extensions/foo.ts, then node test-foo.mjs", exit: 1 },
      { cmd: "cd packages/core && npx tsc --noEmit", exit: 0 },
    ]),
  ),
);
check(
  "(j2) the same red row paired with a build row is silent and counts 1/1",
  r.code === 0 &&
    redBuildWarn(r.stdout).length === 0 &&
    redBuildCounter(r.stdout) === "gate-evidence-red-build: 1/1 red row(s) paired with a build row",
  `exit=${r.code} warn=${redBuildWarn(r.stdout)[0]?.slice(0, 70) ?? "absent"} counter=${redBuildCounter(r.stdout) ?? "absent"}`,
);

r = run(makeSession("no-red.jsonl", withGates([{ cmd: "npm run ci:check", exit: 0 }])));
check(
  "(j3) a block with no red row is not asked the question and prints no counter",
  r.code === 0 && redBuildWarn(r.stdout).length === 0 && redBuildCounter(r.stdout) === undefined,
  `exit=${r.code} counter=${redBuildCounter(r.stdout) ?? "absent"}`,
);

// ── (k) a stamp must be the census of the revision it names ──────────────
//
// The failure this reads is a worker stamping the population it touched: the
// number of changed files recorded where the merge path expects tracked entries.
// The fixture repo's census at its HEAD is two entries, so a stamp of one is
// wrong for its revision and a stamp of two is right, whatever the working tree
// holds.

const censusRun = fx("ls-tree", "-r", "--name-only", fixtureHead);
if (censusRun.status === 0 && censusRun.stdout.trim() !== "") {
  // The census of the STAMPED revision, which is what the merge path compares
  // against; the working tree can legitimately differ from it.
  const tracked = fixtureCensus;
  r = run(
    makeSession(
      "census-wrong.jsonl",
      block({ source_revision: fixtureHead, gate_evidence: [{ cmd: "node packages/core/scripts/check-placement.mjs --strict", exit: 0, stamp: `scanned ${tracked - 1} files at ${fixtureHead}` }] }),
    ),
    ["--repo", fixtureRepo],
  );
  check(
    "(k1) a stamp below the tracked census warns with both numbers",
    r.code === 0 && /WARN gate-evidence census: .*stamps \d+ but .* tracks \d+ entries/.test(r.stdout),
    `exit=${r.code} warn=${(r.stdout.match(/WARN gate-evidence census[^\n]*/) ?? ["absent"])[0].slice(0, 80)}`,
  );
  r = run(
    makeSession(
      "census-right.jsonl",
      block({ source_revision: fixtureHead, gate_evidence: [{ cmd: "node packages/core/scripts/check-placement.mjs --strict", exit: 0, stamp: `scanned ${tracked} entries at ${fixtureHead}` }] }),
    ),
    ["--repo", fixtureRepo],
  );
  check(
    "(k2) the same row stamping the real census is silent",
    r.code === 0 && !/gate-evidence census/.test(r.stdout),
    `exit=${r.code} warn=${/gate-evidence census/.test(r.stdout) ? "present" : "absent"}`,
  );
} else {
  check("(k) census fixture skipped: the fixture repo is not readable", false, `git -C ${fixtureRepo} ls-tree exited ${censusRun.status}`);
}

// ── (l) instrument disclosure: a figure must name the command that made it ──
// The self-review store's most frequent class is a measurement taken through
// something that changed what was measured, so this leg exists to make the
// pairing decidable: a claim stating a figure with a program named is silent, the
// same claim with prose only is a warning under an incomplete status and a
// refusal once the block claims completion.

{
  const disclosed = block({
    source_revision: settled, // the revision resolves, so the disclosure leg is the only subject
    claims: [
      {
        claim: "the suite passes 36 of 36 cases",
        verified_by: "npm run test in packages/telegram, exit 0",
        predicts: "node test-check-result.mjs exits 0",
      },
    ],
  });
  r = run(makeSession("l-disclosed.jsonl", disclosed));
  check(
    "(l1) a figure with the command that produced it is silent",
    r.code === 0 && !/instrument-undisclosed/.test(r.stdout) && /instrument-disclosure: 1\/1 claim\(s\) carry a figure, 0 without a command/.test(r.stdout),
    `exit=${r.code} warn=${/instrument-undisclosed/.test(r.stdout) ? "present" : "absent"}`,
  );

  const prose = block({
    source_revision: settled,
    claims: [
      {
        claim: "the suite passes 36 of 36 cases",
        verified_by: "looked at the output and it was green",
        predicts: "node test-check-result.mjs exits 0",
      },
    ],
  });
  // The tier boundary: an incomplete result may state what it does not know.
  const prosePartial = { ...prose, status: "partial" };
  r = run(makeSession("l-prose-completed.jsonl", prose));
  check(
    "(l2) a completed block whose figure names no command is REFUSED",
    r.code === 1 &&
      failLines(r.stdout) === 1 &&
      /FAIL\s+instrument-disclosure: 1 claim\(s\) state a figure with no command/.test(r.stdout) &&
      /a completed block attests a finished result/.test(r.stdout),
    `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
  );
  r = run(makeSession("l-prose-partial.jsonl", prosePartial));
  check(
    "(l2a) the same claim under status=partial warns and still passes (the tier boundary)",
    r.code === 0 &&
      /WARN instrument-undisclosed: claim 0 states "36 of 36"/.test(r.stdout) &&
      /1 without a command \(advisory: status is not completed/.test(r.stdout),
    `exit=${r.code} warn=${/WARN instrument-undisclosed/.test(r.stdout) ? "present" : "absent"}`,
  );

  r = run(makeSession("l-prose.jsonl", prosePartial), ["--fail-on-instrument"]);
  check(
    "(l3) --fail-on-instrument lifts the warning tier for an incomplete block too",
    r.code === 1 && failLines(r.stdout) === 1 && /FAIL\s+instrument-disclosure: 1 claim\(s\) state a figure with no command/.test(r.stdout),
    `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
  );

  // A named command field is disclosure even when the prose is quiet.
  const fieldCmd = block({
    source_revision: settled,
    // The command field names a runnable file, so the block also carries the row
    // that records that run: disclosure and parity are separate reads, and a
    // block that names a program is asked for both.
    gate_evidence: [{ cmd: "node check-dossiers.mjs --all", exit: 0 }],
    claims: [
      {
        claim: "72 dossiers were read",
        verified_by: "the dossier set",
        command: "node check-dossiers.mjs --all",
        predicts: "node check-dossiers.mjs --all exits 0",
      },
    ],
  });
  r = run(makeSession("l-field.jsonl", fieldCmd));
  check(
    "(l4) a command field counts as disclosure",
    r.code === 0 && !/instrument-undisclosed/.test(r.stdout),
    `exit=${r.code} warn=${/instrument-undisclosed/.test(r.stdout) ? "present" : "absent"}`,
  );
}

// ── (m) gate-evidence shape: a row must carry {cmd, exit} ───────────────────
// A prose row reads fine to a person and cannot be re-run by the sampler, so the
// evidence behind a close is unreadable exactly when someone needs it. The gap
// was a WARN until the registry was counted (2 899 of 2 899 rows already shaped),
// and these cases pin the refusal.

{
  const prose = block({ source_revision: settled, gate_evidence: ["check ran, all green", "placement clean (seat)"] });
  r = run(makeSession("m-prose.jsonl", prose));
  check(
    "(m1) prose gate rows fail the shape check",
    r.code === 1 && /FAIL\s+gate-evidence-shape\s+\(0\/2 row/.test(r.stdout),
    `exit=${r.code} fail=${(r.stdout.match(/FAIL\s+gate-evidence-shape[^\n]*/) ?? ["absent"])[0].slice(0, 60)}`,
  );

  const noExit = block({ source_revision: settled, gate_evidence: [{ cmd: "true" }] });
  r = run(makeSession("m-noexit.jsonl", noExit));
  check(
    "(m2) an object without an exit code fails the same way",
    r.code === 1 && /FAIL\s+gate-evidence-shape/.test(r.stdout),
    `exit=${r.code} fail=${(r.stdout.match(/FAIL\s+gate-evidence-shape[^\n]*/) ?? ["absent"])[0].slice(0, 60)}`,
  );

  const shaped = block({ source_revision: settled, gate_evidence: [{ cmd: "true", exit: 0 }] });
  r = run(makeSession("m-shaped.jsonl", shaped));
  check(
    "(m3) a {cmd, exit} row passes",
    r.code === 0 && !/FAIL\s+gate-evidence-shape/.test(r.stdout),
    `exit=${r.code} fail=${/FAIL\s+gate-evidence-shape/.test(r.stdout) ? "present" : "absent"}`,
  );
}

// ── (n) a blocked close names the field the contract reads ──────────────────
// The validator asks for `blocked_reason`. A close that writes only `reason`
// has not said why it stopped, and the refusal has to name the field it wanted:
// the writer that reads it is out of context, and a message naming no field
// sends it to the same guess again. A legacy alias is not read, and the message
// says so. Each block is otherwise valid, so the verdict is this leg alone.

{
  const withReason = block({
    status: "blocked",
    source_revision: settled,
    blocked_reason: "waits on the fixture",
  });
  r = run(makeSession("n-blocked-reason.jsonl", withReason));
  check(
    "(n1) a blocked block carrying blocked_reason passes",
    r.code === 0 && /PASS\s+blocked-reason/.test(r.stdout),
    `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
  );

  const legacy = block({ status: "blocked", source_revision: settled, reason: "waits on the fixture" });
  r = run(makeSession("n-legacy-reason.jsonl", legacy));
  check(
    "(n2) a blocked block carrying only reason fails, and the message names blocked_reason",
    r.code === 1 &&
      failLines(r.stdout) === 1 &&
      /FAIL\s+blocked-reason\s+\(blocked requires blocked_reason; a reason field is not read\)/.test(r.stdout),
    `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
  );

  const neither = block({ status: "blocked", source_revision: settled });
  r = run(makeSession("n-no-reason.jsonl", neither));
  check(
    "(n3) a blocked block carrying neither fails with the same field name",
    r.code === 1 &&
      failLines(r.stdout) === 1 &&
      /FAIL\s+blocked-reason\s+\(blocked requires blocked_reason\)/.test(r.stdout),
    `exit=${r.code} fail-lines=${failLines(r.stdout)}`,
  );
}

// ── (o) claim–row parity: a cited run has to be a recorded run ──────────────
//
// A claim may cite a test file while no row records its command or its exit, and
// then the claim is the only statement that the test passed. These cases pin the
// pairing and the boundaries that keep it from firing on a read: a git command,
// a file read and a quoted output naming no file carry no obligation; an
// `unverified` claim carries none; an artifact is not an exemption; and an
// incomplete block keeps the row without the exit constraint. Paths are compared
// as spellings, so the two directions of the absolute/relative pair are separate
// cases.

const citedFile = "packages/core/test/runtime/gate-x.mjs";
const parityFail = (stdout) => stdout.split("\n").filter((l) => l.startsWith("FAIL claim-row-parity:"));
const parityCounter = (stdout) => stdout.split("\n").find((l) => l.startsWith("claim-row-parity:"));
const paritySession = (name, claims, rows, extra = {}) =>
  makeSession(name, block({ source_revision: settled, claims, gate_evidence: rows, ...extra }));
const passingClaim = { claim: "the fixture leg passes", verified_by: `node ${citedFile}` };

r = run(paritySession("parity-matched.jsonl", [passingClaim], [{ cmd: `node ${citedFile}`, exit: 0 }]));
check(
  "(o1) a claim citing a test file, with the row that records that run, passes",
  r.code === 0 &&
    /RESULT: PASS/.test(r.stdout) &&
    parityFail(r.stdout).length === 0 &&
    parityCounter(r.stdout) === "claim-row-parity: 1/1 claim(s) citing a runnable file are matched by a gate row",
  `exit=${r.code} counter=${parityCounter(r.stdout) ?? "absent"}`,
);

r = run(paritySession("parity-unmatched.jsonl", [passingClaim], [{ cmd: "true", exit: 0 }]));
check(
  "(o2) the same claim with no row naming the file is refused, naming the claim, the file and the rows searched",
  r.code === 1 &&
    failLines(r.stdout) === 1 &&
    parityFail(r.stdout).length === 1 &&
    /claim 0/.test(parityFail(r.stdout)[0]) &&
    parityFail(r.stdout)[0].includes(citedFile) &&
    /searched 1 row\(s\): "true"/.test(parityFail(r.stdout)[0]),
  `exit=${r.code} fail-lines=${failLines(r.stdout)} line=${parityFail(r.stdout)[0]?.slice(0, 90) ?? "absent"}`,
);

const redRow = [{ cmd: `node ${citedFile}`, exit: 5 }];
r = run(paritySession("parity-exit-completed.jsonl", [passingClaim], redRow));
check(
  "(o3) a matching row that exits non-zero under completed is refused, naming the exit code",
  r.code === 1 &&
    failLines(r.stdout) === 1 &&
    parityFail(r.stdout).length === 1 &&
    /claim 0/.test(parityFail(r.stdout)[0]) &&
    /exits 5/.test(parityFail(r.stdout)[0]),
  `exit=${r.code} line=${parityFail(r.stdout)[0]?.slice(0, 90) ?? "absent"}`,
);

r = run(paritySession("parity-exit-partial.jsonl", [passingClaim], redRow, { status: "partial" }));
check(
  "(o3) the same row under status=partial passes, and the lifted exit is stated",
  r.code === 0 &&
    /RESULT: PASS/.test(r.stdout) &&
    parityFail(r.stdout).length === 0 &&
    /WARN claim-row-exit: claim 0 cites .*gate-x\.mjs and its row 0 exits 5 — status=partial/.test(r.stdout) &&
    parityCounter(r.stdout) === "claim-row-parity: 1/1 claim(s) citing a runnable file are matched by a gate row",
  `exit=${r.code} warn=${/WARN claim-row-exit/.test(r.stdout) ? "present" : "absent"}`,
);

// Normalisation: the two spellings are one file, in both directions. The file
// need not exist; the rule compares paths, and the repo argument is what makes a
// relative spelling absolute.
const normalRepo = join(root, "parity-repo");
mkdirSync(normalRepo, { recursive: true });
const relativeCited = "tests/gate-y.mjs";
const absoluteCited = join(normalRepo, relativeCited);
for (const [name, claimSpelling, rowSpelling] of [
  ["a relative claim matches an absolute row", relativeCited, absoluteCited],
  ["an absolute claim matches a relative row", absoluteCited, relativeCited],
]) {
  const rr = run(
    paritySession(
      `parity-normalise-${name.includes("relative claim") ? "rel" : "abs"}.jsonl`,
      [{ claim: "the fixture leg passes", verified_by: `node ${claimSpelling}` }],
      [{ cmd: `node ${rowSpelling}`, exit: 0 }],
    ),
    ["--repo", normalRepo],
  );
  check(
    `(o4) ${name}, resolved against --repo`,
    rr.code === 0 &&
      parityFail(rr.stdout).length === 0 &&
      parityCounter(rr.stdout) === "claim-row-parity: 1/1 claim(s) citing a runnable file are matched by a gate row",
    `exit=${rr.code} counter=${parityCounter(rr.stdout) ?? "absent"}`,
  );
}

for (const [name, verifiedBy] of [
  // The git case names the path bare, after the subcommand, so the exemption that
  // answers it is the instrument word and not the token shape: `git show
  // <rev>:x.mjs` never reaches the file regex, and a case built on it would pass
  // whether or not the boundary existed.
  ["a git command", `git log --oneline -- ${citedFile}`],
  ["a read of the file", `read ${citedFile}: the file states the invariant`],
  ["a quoted output naming no file", 'the quoted output: all green, no failures'],
]) {
  const rr = run(
    paritySession(`parity-exempt-${name.replace(/\W+/g, "-")}.jsonl`, [{ claim: "the fixture leg passes", verified_by: verifiedBy }], [
      { cmd: "true", exit: 0 },
    ]),
  );
  check(
    `(o5) ${name} carries no parity obligation`,
    rr.code === 0 && parityFail(rr.stdout).length === 0 && parityCounter(rr.stdout) === undefined,
    `exit=${rr.code} counter=${parityCounter(rr.stdout) ?? "absent"}`,
  );
}

r = run(
  paritySession("parity-unverified.jsonl", [{ ...passingClaim, verdict: "unverified" }], [{ cmd: "true", exit: 0 }]),
);
check(
  "(o5) a claim whose verdict is unverified carries no obligation",
  r.code === 0 && parityFail(r.stdout).length === 0 && parityCounter(r.stdout) === undefined,
  `exit=${r.code} counter=${parityCounter(r.stdout) ?? "absent"}`,
);

r = run(paritySession("parity-artifact.jsonl", [passingClaim], [{ cmd: "true", exit: 0 }], { artifacts: [citedFile] }));
check(
  "(o5) a cited file the block also lists in artifacts is still obliged (an artifact is a product)",
  r.code === 1 && parityFail(r.stdout).length === 1 && parityFail(r.stdout)[0].includes(citedFile),
  `exit=${r.code} line=${parityFail(r.stdout)[0]?.slice(0, 80) ?? "absent"}`,
);

const commandClaim = { claim: "the dossier set was read", verified_by: "the dossier set", command: `node ${citedFile} --all` };
r = run(paritySession("parity-command.jsonl", [commandClaim], [{ cmd: "true", exit: 0 }]));
check(
  "(o6) a command field naming the file is obliged too",
  r.code === 1 && parityFail(r.stdout).length === 1 && parityFail(r.stdout)[0].includes(citedFile),
  `exit=${r.code} line=${parityFail(r.stdout)[0]?.slice(0, 80) ?? "absent"}`,
);

r = run(
  paritySession("parity-command-row.jsonl", [commandClaim], [{ cmd: `node ${citedFile} --all`, exit_code: 0 }]),
);
check(
  "(o6) the same command field passes when the row records it (exit_code spelling)",
  r.code === 0 &&
    parityFail(r.stdout).length === 0 &&
    parityCounter(r.stdout) === "claim-row-parity: 1/1 claim(s) citing a runnable file are matched by a gate row",
  `exit=${r.code} counter=${parityCounter(r.stdout) ?? "absent"}`,
);

// ── (p) a sampling claim needs the sampler, and its absence is named ────────
//
// A row shaped {cmd, exit} is sampleable, so the gate accepts the block's own
// account of what the command returned. Nothing re-runs it: the re-runner is
// `gate-sampler.mjs` beside the script, and when the file is not there the
// block is credited on two fields one worker wrote. These cases pin the line
// that says so, and its two boundaries: a sampler beside the script silences
// it, and a block carrying no row makes no sampling claim to qualify.

const samplerWarn = (stdout) =>
  stdout.split("\n").find((l) => l.startsWith("WARN gate-evidence: the sampler is not beside this script"));
const samplerPath = join(CHECK_RESULT, "..", "gate-sampler.mjs");

{
  const exitsOne = join(root, "exits-one.sh");
  writeFileSync(exitsOne, "#!/bin/sh\nexit 1\n");
  chmodSync(exitsOne, 0o755);
  // The row records the exit the block wants credited, not the one the script
  // returns; the claim cites the same file, which is the shape the parity leg
  // matches. Nothing in this case re-runs it.
  const unrun = block({
    source_revision: settled,
    gate_evidence: [{ cmd: exitsOne, exit: 0 }],
    claims: [
      { claim: "the fixture script passes when run", verified_by: exitsOne, predicts: "the script exits 0 when run" },
    ],
  });

  r = run(makeSession("p-absent-sampler.jsonl", unrun));
  check(
    "(p1) a sampleable row with no sampler beside the script warns, naming the absent file",
    r.code === 0 && samplerWarn(r.stdout) !== undefined && samplerWarn(r.stdout).includes(samplerPath),
    `exit=${r.code} line=${(samplerWarn(r.stdout) ?? "absent").slice(0, 100)}`,
  );

  const withSampler = join(root, "with-sampler");
  mkdirSync(withSampler, { recursive: true });
  const copied = join(withSampler, "check-result.mjs");
  copyFileSync(CHECK_RESULT, copied);
  writeFileSync(join(withSampler, "gate-sampler.mjs"), "// a re-runner these cases never call\n");

  const rr = run(makeSession("p-with-sampler.jsonl", unrun), [], { checkResult: copied });
  check(
    "(p2) a sampler beside the script silences the warning, and the row still passes the shape gate",
    rr.code === 0 && samplerWarn(rr.stdout) === undefined && /PASS\s+gate-evidence/.test(rr.stdout),
    `exit=${rr.code} line=${(samplerWarn(rr.stdout) ?? "absent").slice(0, 60)}`,
  );

  // A row the gate cannot sample carries no exit to re-run, so the absence
  // warning has nothing to qualify: the shape gate is the line that speaks, and
  // the two must not both report one defect.
  const proseRows = block({ source_revision: settled, gate_evidence: ["check ran, all green"] });
  const r3 = run(makeSession("p-prose-rows.jsonl", proseRows));
  check(
    "(p3) a block whose rows are not sampleable makes no sampling claim, so only the shape gate reports it",
    r3.code === 1 && samplerWarn(r3.stdout) === undefined && /FAIL\s+gate-evidence-shape/.test(r3.stdout),
    `exit=${r3.code} line=${(samplerWarn(r3.stdout) ?? "absent").slice(0, 60)}`,
  );
}

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? `RESULT: PASS (${checks} checks)` : `RESULT: FAIL (${failures}/${checks} checks)`}`);
if (failures === 0) rmSync(root, { recursive: true, force: true });
else console.log(`fixtures kept for inspection: ${root}`);
process.exit(failures === 0 ? 0 : 1);

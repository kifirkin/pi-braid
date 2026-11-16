#!/usr/bin/env node
// check-result.mjs — validate a worker's final-message result block.
//
//   node packages/core/scripts/check-result.mjs <session.jsonl> [--repo <path>]...
//           [--strict-staleness] [--fail-on-instrument]
//
// Reads the worker's pi session JSONL, extracts the LAST fenced ```json block
// from the FINAL assistant message that carries one, validates the schema fields
// (including `source_revision`, the revision the evidence was read at, resolved
// against the repositories named below), and stats the declared output_file.
// Exit 0 = every check passes; 2 = no result block; 1 = a check failed; 64 = usage.
//
// Contract note: the pane is liveness only; the session record is the attestation;
// the output_file is the artifact. This validates the attestation against the
// filesystem, and it does not trust prose. It never executes a command quoted by
// its subject: a gate that runs its subject's strings has handed the subject a
// shell, which is the capability a reviewer must not hand over.
//
// Claim entries must be objects with non-empty claim text and a named verifier
// (`verified_by`).
//
// Three reads refuse instead of warning, each keyed to what the block claims
// about itself:
//   - `source_revision` must resolve in a repository the gate can see. A
//     revision that exists nowhere cannot attest the tree its evidence was read
//     at, and 7-to-40 hex characters are the whole of what a fabricated one has
//     to get right. `--repo <path>` (repeatable) adds a repository; without it
//     the search set is `BRAID_GATE_REPOS`, `$PWD` and this file's own checkout.
//   - a `completed` block's figure must name the instrument that produced it, in
//     `verified_by` or in a `command` field. Under `partial`, `blocked` or
//     `error` the same claim is a warning: an incomplete result is allowed to
//     say what it does not know.
//   - a `completed` block may not carry a `gate_evidence` row whose subject is a
//     population with an absent or unreadable `stamp`, because the merge path
//     compares that record against the census the revision it names holds. The
//     grammar is `scanned <n> <unit> at <revision>`: `n` a non-negative integer,
//     `unit` one lowercase word, `revision` a 7-to-40-char hex sha or a ref name.
//     `packages/core/src/lib/orchestrator/workers.ts` parses the same shape at
//     the merge path.
//
// Everything else keeps its tier: a warning is a read that has not earned a
// refusal yet.
//
// The orchestrator tree that used to hold this file keeps a forwarder to it, so a
// brief naming that path still works. This copy is the one a reviewer reads and
// the one the `check:close-gate` leg of `ci:check` runs.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPECS = ["research", "impl", "verify", "audit", "project"];
const STATUSES = ["completed", "partial", "blocked", "error"];
const REQUIRED = ["worker", "spec", "status", "output_file", "artifacts", "gate_evidence", "claims"];

// ── Instrument-capability registry (the claim contract's pairing read) ──────
// A claim asserts a property; its `verified_by` names an instrument. This
// registry maps the verifier's shape to the observation classes the instrument
// can make, and the claim's wording to the property class it asserts, then
// warns when the pair cannot observe what the claim asserts: a coverage or
// elimination claim ("gone", "no remaining", "every reader") grounded on a
// search/count verb with no census named; a content claim grounded only on an
// artifact citation (a description is not the artifact's content); a
// classification claim ("only", "private", "leak") grounded on a bare count
// with no decomposition. The tables are data, generic English shapes only — no
// project, file, path or worker vocabulary enters them. A verifier matching no
// class observes nothing this registry knows; that residue is the seat's
// re-derivation job, and the tier is warn-only: it never refuses a block.
const VERIFIER_CLASSES = {
  search_count: /\b(grep|rg|search(?:ed|es)?|sweep|find|scanned?|scan|wc\b|count(?:ed|s)?|hits?)\b/,
  artifact_citation: /\b(report|readme|changelog|description|docs?|documentation)\b/,
  execution: /\b(boot(?:ed)?|install(?:ed)?|start(?:ed|s)?|ran|runs?|running|exit(?:ed|s)?|exit code|healthcheck|gates?|suite)\b/,
  content: /\b(measured|enumerat(?:ed|es|ion)?|re-?read|read|fetch(?:ed|es)?|git show|bytes|entries|lines|content|inspected|opened|cat\b|sha256|diff|re-?derived|replay(?:ed)?|probe[d]?)\b/,
  enumeration: /\b(git ls-files|ls-files|census|ast\b|type-aware|tsc\b|test suite|suite run|full suite|row count|enumerate|walk(?:ed)?|full list|every file|all files|all \d+ files)\b/,
};

// Claim wording -> the property class the claim asserts.
const CLAIM_CLASSES = {
  coverage: /\b(gone|no remaining|none remain|no other|no longer|removed|deleted|fixed everywhere|every reader|nothing left|nothing else|free of|clean sweep|eliminated)\b/,
  classification: /\b(leak|private|secret|only|all\b|classified|categories|classes)\b/,
  content: /\b(contains|content|bytes|fields|values|entries|rows|lines|number of \w+|the file|file says)\b/,
  description: /\b(stub|empty|placeholder|description|described|labelled|labeled)\b/,
};

// A count is "bare" when no decomposition of it is named in the claim or the verifier.
const COUNT_VERBS = /\b(count(?:ed|s)?|wc -l|grep -c|hits)\b/;
const DECOMPOSITION_WORDS = /\b(decompos(?:ed|ition)?|broken down|breakdown|of which|split|per-|by source|by type|each of|separate|sub-?population)\b/;

// The census shapes D4's elimination clause asks for, printed in the warn.
const CENSUS_SUGGESTION = "git ls-files, an AST or type-aware census, a suite run, or an explicit row count";

function classesMatching(text, table) {
  if (typeof text !== "string" || text === "") return [];
  return Object.entries(table).filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * The pairing read over a result block's claim entries. Pure (no I/O): the
 * registry dry-run driver imports it so the shipped rule and the corpus
 * measurement are one code path. One finding per warned claim; `entries` is
 * the claim-entry population, `read` those carrying both claim text and a
 * verifier, `decidable` those whose verifier matched a registry class.
 */
function evaluateClaimCapability(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const findings = [];
  const counts = { "coverage-on-search": 0, "content-on-citation": 0, "classification-on-bare-count": 0 };
  let read = 0;
  let decidable = 0;
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const claimText = typeof entry.claim === "string" ? entry.claim : "";
    const verifiedBy = typeof entry.verified_by === "string" ? entry.verified_by : "";
    if (claimText.trim() === "" || verifiedBy.trim() === "") continue;
    read++;
    const observing = classesMatching(verifiedBy, VERIFIER_CLASSES);
    if (observing.length === 0) continue;
    decidable++;
    const asserted = classesMatching(claimText, CLAIM_CLASSES);
    const namesEnumeration = observing.includes("enumeration");
    const nonEnumeration = observing.filter((name) => name !== "enumeration");
    const rules = [];
    // D4: an elimination or coverage claim must ground on a census, not a search.
    if (asserted.includes("coverage") && observing.includes("search_count") && !namesEnumeration) {
      rules.push("coverage-on-search");
    }
    // D3: an artifact's description observes the description, not the content.
    if (asserted.includes("content") && nonEnumeration.length > 0 && nonEnumeration.every((name) => name === "artifact_citation")) {
      rules.push("content-on-citation");
    }
    // D3: a bare count with no decomposition cannot ground a classification.
    if (
      asserted.includes("classification") &&
      COUNT_VERBS.test(verifiedBy) &&
      !DECOMPOSITION_WORDS.test(claimText) &&
      !DECOMPOSITION_WORDS.test(verifiedBy)
    ) {
      rules.push("classification-on-bare-count");
    }
    for (const rule of rules) counts[rule]++;
    if (rules.length > 0) findings.push({ index, asserted, observing, rules });
  }
  return {
    entries: list.length,
    read,
    decidable,
    counts,
    findings,
    warnings: findings.map(capabilityWarningLine),
  };
}

function capabilityWarningLine(finding) {
  const tail = finding.rules.includes("coverage-on-search")
    ? `no census named — cite ${CENSUS_SUGGESTION}`
    : finding.rules.includes("content-on-citation")
      ? "the description of an artifact is not its content — read bytes, entries or lines, or cite a re-derivation"
      : "name the decomposition of the count (by source, by type, or per population)";
  return (
    `WARN claim-capability: claim ${finding.index} [${finding.rules.join("+")}] ` +
    `asserted ${finding.asserted.join("/")}, observed through ${finding.observing.join("/")} — ${tail}`
  );
}

// ── Instrument disclosure for measured claims ──────────────────────────
// The most frequent failure class in the self-review store is instrument-misread:
// a measurement taken through something that changed what was measured (a shell
// that re-exported a token, a Stats object whose getter is on the prototype, a
// byte count read as a character count). The class is decidable at this gate
// because every instance names a figure and either names the command that
// produced it or does not. This rule reads that pairing and never executes what
// a report says: a gate that runs commands quoted by its subject has given the
// subject a shell, which is the capability a reviewer must not hand over.
const MEASURED_FIGURE_RE =
  /(\d+[.,]?\d*\s*%|\d+\s*(?:of|из)\s*\d+|\d+\s+(?:files?|rows?|lines?|bytes?|entries|claims?|tests?|cases?|skills?|tokens?|pages?|ms|secs?|seconds?|файл\w*|строк\w*|байт\w*|запис\w*|тест\w*|случа\w*|навык\w*|страниц\w*|мс|сек\w*))/iu;
// A command is a token of a program a reader could run, or a backticked span that
// contains one. Naming a file is not naming a command: `report.md` says where an
// answer lives, not how it was produced.
const COMMAND_TOKEN_RE =
  /(?:^|[\s`'"|(])(node|npm|npx|git|rg|grep|wc|ls|find|cat|jq|python3?|tsc|curl|shasum|sha256sum|openssl|lp|lpstat|ps|df|bash|sh|zsh|make|docker|stat|file)\b/i;

/** Findings for claims that carry a measured figure without naming its command. */
function evaluateInstrumentDisclosure(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const findings = [];
  let read = 0;
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const claim = typeof entry.claim === "string" ? entry.claim : "";
    const verifiedBy = typeof entry.verified_by === "string" ? entry.verified_by : "";
    const text = `${claim} ${verifiedBy}`;
    if (!MEASURED_FIGURE_RE.test(text)) continue;
    read++;
    const named = typeof entry.command === "string" && entry.command.trim() !== "";
    if (named || COMMAND_TOKEN_RE.test(text)) continue;
    const figure = String(text.match(MEASURED_FIGURE_RE)[0]).trim();
    findings.push({ index, figure, environment: typeof entry.environment === "string" && entry.environment.trim() !== "" });
  }
  return { entries: list.length, withFigure: read, findings };
}

function instrumentWarningLine(finding) {
  return (
    `WARN instrument-undisclosed: claim ${finding.index} states ${JSON.stringify(finding.figure)} ` +
    `without the command that produced it — name the exact command and the environment it ran in, or drop the figure`
  );
}

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

// The registry and its pairing read are exported for the dry-run driver, which
// must recompute the corpus numbers through this same code path; everything
// below runs only when this file is the process entry point. Real paths are
// compared so a symlinked invocation (`~/.pi/agent/...`) still counts as direct.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (invokedDirectly) {
let INSTRUMENT_ENFORCED = false;
const sessionPath = process.argv[2];
if (!sessionPath) { console.error("usage: node check-result.mjs <worker-session.jsonl> [--repo <path>]..."); process.exit(64); }
// Extra repos to resolve source_revision against, for a close whose work ran
// outside this machine's own checkouts. Without this a block from another project
// is accepted on shape alone (a WARN), which is the wrong verdict for a block
// whose revision is perfectly checkable - the caller just has to name the repo.
const EXTRA_REPOS = [];
let STRICT_STALENESS = false;
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === "--repo" && process.argv[i + 1]) EXTRA_REPOS.push(process.argv[++i]);
  else if (process.argv[i] === "--strict-staleness") STRICT_STALENESS = true;
  else if (process.argv[i] === "--fail-on-instrument") INSTRUMENT_ENFORCED = true;
  else if (process.argv[i] !== "--repo") { console.error(`usage: unknown argument ${process.argv[i]}`); process.exit(64); }
}

function assistantTexts(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { fail(`cannot read session file: ${path} (${e.message})`); }
  const texts = [];
  let assistantEntries = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
    assistantEntries++;
    const content = entry.message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
    }
    if (text) texts.push(text);
  }
  assistantTexts.entries = assistantEntries;
  return texts;
}

function extractLastSchema(texts) {
  for (let i = texts.length - 1; i >= 0; i--) {
    const blocks = [...texts[i].matchAll(/```json\s*([\s\S]*?)```/g)];
    for (let j = blocks.length - 1; j >= 0; j--) {
      let parsed; try { parsed = JSON.parse(blocks[j][1]); } catch { continue; }
      if (parsed && typeof parsed === "object" && ("output_file" in parsed || "gate_evidence" in parsed)) {
        return { schema: parsed, messageIndex: i };
      }
    }
  }
  return null;
}

const texts = assistantTexts(sessionPath);
if (texts.length === 0) {
  // Distinguish "the worker has not finished" from "the worker finished without a
  // result block". The old wording said "no assistant messages found" for both, which
  // is false whenever the session carries assistant entries whose content is only
  // thinking and tool calls — a mid-flight worker, or one that never writes prose.
  // That wording cost real time twice: it reads as a broken validator and sends the
  // reader hunting a bug in this script instead of waiting for the worker.
  const n = assistantTexts.entries ?? 0;
  fail(
    n === 0
      ? "no assistant messages in session (the session may be empty or truncated)"
      : `no assistant TEXT yet: ${n} assistant message(s), none carrying a text part ` +
        "— the worker is still mid-flight (thinking and tool calls only), or it finished without prose. " +
        "Re-run when it settles.",
  );
}

const found = extractLastSchema(texts);
if (!found) { console.error("FAIL: no result-schema JSON block found in any assistant message"); process.exit(2); }
const { schema } = found;

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

for (const key of REQUIRED) check(`field:${key}`, key in schema, key in schema ? "" : "missing");
check("spec-enum", SPECS.includes(schema.spec), String(schema.spec));
check("status-enum", STATUSES.includes(schema.status), String(schema.status));
check("worker-id", typeof schema.worker === "string" && schema.worker.length > 0, String(schema.worker));
check("artifacts-array", Array.isArray(schema.artifacts), Array.isArray(schema.artifacts) ? `${schema.artifacts.length} entries` : "not an array");
check("gate-evidence", Array.isArray(schema.gate_evidence) && schema.gate_evidence.length > 0, Array.isArray(schema.gate_evidence) ? `${schema.gate_evidence.length} entries` : "not an array");
// Shape, not just presence. A string row ("check ran, all green") reads fine to
// a human and cannot be re-run by the sampler, so the evidence behind a close
// is unreadable at exactly the moment someone needs it. The gap was documented
// as a warning until the share was measured: every gate row in every project
// registry is already {cmd, exit} (2 899 of 2 899), so this costs no valid
// block its status.
const sampleableGate = (g) =>
  g &&
  typeof g === "object" &&
  !Array.isArray(g) &&
  typeof g.cmd === "string" &&
  g.cmd.trim() !== "" &&
  (typeof g.exit_code === "number" || typeof g.exit === "number");
const gateRows = Array.isArray(schema.gate_evidence) ? schema.gate_evidence : [];
const shapedGateRows = gateRows.filter(sampleableGate).length;
check(
  "gate-evidence-shape",
  gateRows.length === 0 || shapedGateRows === gateRows.length,
  gateRows.length === 0 ? "" : `${shapedGateRows}/${gateRows.length} row(s) carry {cmd, exit}`,
);
check("claims-array", Array.isArray(schema.claims), Array.isArray(schema.claims) ? `${schema.claims.length} entries` : "not an array");
// Claim shape: an entry must be an object carrying non-empty claim text and a
// named verifier. The claims-mode probe family measured letter-only shapes
// passing both instruments (a bare string; an object with no verified_by; a
// predicts citing a no-op; a claim contradicting its own gate_evidence); the
// verifier requirement closes every one that is shape-decidable. What stays
// semantic (a verifier naming a command that asserts nothing) is the seat's
// re-derivation job — gate-sampler --claims cites, it does not re-derive.
const claimEntries = Array.isArray(schema.claims) ? schema.claims : [];
const claimObjects = claimEntries.filter((c) => c && typeof c === "object" && !Array.isArray(c));
check("claims-shape", claimObjects.length === claimEntries.length, claimObjects.length === claimEntries.length ? "" : `${claimEntries.length - claimObjects.length} non-object entr(ies)`);
const noClaimText = claimObjects.filter((c) => typeof c.claim !== "string" || c.claim.trim() === "").length;
check("claims-text", noClaimText === 0, noClaimText === 0 ? "" : `${noClaimText} entr(ies) without claim text`);
const noVerifiedBy = claimObjects.filter((c) => typeof c.verified_by !== "string" || c.verified_by.trim() === "").length;
check("claims-verified-by", noVerifiedBy === 0, noVerifiedBy === 0 ? "" : `${noVerifiedBy} entr(ies) without verified_by`);
// A verifier that names nothing is the same hole as no verifier at all. The
// decidable part is a bare weasel word ("test", "checked", "read the file") or
// a string too short to name anything: measured over the 607 claims in the
// ledger, this refuses 1 (0.2%) and the instance it catches is exactly the
// claim that named no instrument. A verifier that is prose but names no
// artifact or command stays a WARN, because forcing a cosmetic path would be
// the theatre this rule exists to prevent — the residue is the seat's
// re-derivation job, as the note above says.
const WEASEL_VERIFIERS = new Set(["checked", "verified", "tested", "confirm", "confirmed", "read", "reviewed", "looked", "manual", "n/a", "na", "tbd", "ok", "done", "yes", "true", "asserted", "obvious", "trivial", "by hand", "eyeballed", "see report", "in the report", "as above", "per the report"]);
function verifierNamesNothing(v) {
  const s = String(v).trim().toLowerCase().replace(/[.;:,!]+$/, "");
  if (s.length < 12) return true;
  if (WEASEL_VERIFIERS.has(s)) return true;
  const words = s.split(/\s+/);
  return words.length <= 3 && words.some((w) => WEASEL_VERIFIERS.has(w));
}
function verifierNamesAnArtifact(v) {
  return /[/\\`]|\.\w{2,4}\b|\b(node|npm|git|curl|grep|rg|test|run|cat|jq|python|shasum|openssl|ssh|docker|vitest|eslint|tsc|exit)\b/.test(String(v).toLowerCase());
}

// ── Population-scan recognition and the stamp contract ──────────────────────
// A gate whose subject is a file or row population is recognized from its
// command's verb shape alone — a walk, list or count verb in the command — and
// must carry the stamp `scanned <n> <unit> at <revision>` on its evidence row.
// The verb table is the whole of what this read learns about a command: no
// project vocabulary, no script names, no class words. A miss is accepted (a
// wrapper whose walk is inside a script reads as unrecognized); a hit without
// the record warns at ship, because the merge path is the only instrument that
// can test the number against git, and it reads only this record.
const POPULATION_VERBS = new Set(["ls", "ls-tree", "ls-files", "find", "fd", "wc", "rg", "grep"]);
// The unit is one token of lowercase letters and digits, hyphen/underscore-
// joined and starting with a letter (`files`, `rows`, `test-files`). This
// regex is a second copy of the repo-side parser's pattern; the two must agree
// on what a readable stamp is, or the validator calls a correct stamp
// unparseable and the merge path compares the same row without complaint.
const POPULATION_STAMP_RE =
  /^scanned (\d+) ([a-z][a-z0-9]*(?:[_-][a-z0-9]+)*) at ([0-9a-fA-F]{7,40}|[A-Za-z0-9][A-Za-z0-9._/-]*)$/;
const ALL_HEX_TOKEN_RE = /^[0-9a-fA-F]+$/;

/** The population verbs a command's tokens carry (empty: not recognized). */
function populationVerbsIn(cmd) {
  if (typeof cmd !== "string" || cmd.trim() === "") return [];
  return cmd
    .split(/[\s|;&()<>]+/)
    .filter((token) => POPULATION_VERBS.has(token));
}

/**
 * The stamp shape, shared with the repo-side parser: `n` a non-negative
 * integer, `unit` one lowercase token (letters and digits, `-`/`_`-joined),
 * `revision` a 7-to-40-char hex sha or a ref name (a shorter all-hex token is a
 * prefix, not a revision git resolves).
 */
function parsePopulationStamp(value) {
  if (typeof value !== "string") return null;
  const match = POPULATION_STAMP_RE.exec(value);
  if (!match) return null;
  const revision = match[3];
  if (ALL_HEX_TOKEN_RE.test(revision) && (revision.length < 7 || revision.length > 40)) return null;
  return { n: Number(match[1]), unit: match[2], revision };
}

/** One command excerpt for a warning line, bounded and single-line. */
function commandExcerpt(cmd) {
  const text = typeof cmd === "string" ? cmd.replace(/\s+/g, " ").trim() : String(cmd);
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}
const weaselVerifier = claimObjects.filter((c) => typeof c.verified_by === "string" && verifierNamesNothing(c.verified_by));
check("claims-verified-by-names", weaselVerifier.length === 0, weaselVerifier.length === 0 ? "" : `${weaselVerifier.length} entr(ies) whose verified_by names no instrument (${weaselVerifier.map((c) => JSON.stringify(String(c.verified_by).slice(0, 40))).join(", ")})`);
const unsourcedVerifier = claimObjects.filter((c) => typeof c.verified_by === "string" && !verifierNamesNothing(c.verified_by) && !verifierNamesAnArtifact(c.verified_by));
if (schema.status === "blocked") check("blocked-reason", typeof schema.blocked_reason === "string" && schema.blocked_reason.length > 0, "blocked requires reason");

let outputOk = false, outputDetail;
if (typeof schema.output_file === "string" && schema.output_file.startsWith("/")) {
  try {
    const st = statSync(schema.output_file);
    outputOk = st.isFile();
    outputDetail = `${st.size} bytes`;
  } catch { outputDetail = "does not exist"; }
} else outputDetail = "not an absolute path";
check("output-file-exists", outputOk, outputDetail);
if (schema.status === "completed" && !outputOk) {
  check("completed-requires-output", false, "status=completed but output_file missing (false-done)");
}

// Placement section requirement (identity placement mechanism): impl/audit/verify
// outputs must carry a `## Placement` section — layer changed, domain literals
// added to generic layers, what remains unverified. Its absence is the same
// class as a false-done: the close did not state where its change lives.
if (["impl", "audit", "verify"].includes(schema.spec)) {
  let hasPlacement = false, placementDetail = "output file unreadable";
  if (outputOk) {
    try {
      const content = readFileSync(schema.output_file, "utf8");
      // A numbered heading (`## 7. Placement`) is the same declaration as a
      // bare one; requiring the word to open the heading failed a report that
      // had it, which is the dangerous direction for an enforcement check.
      hasPlacement = /^#{1,6}\s*(?:\d+(?:\.\d+)*[.)]?\s+)?placement\b/im.test(content);
      placementDetail = hasPlacement ? "present" : "missing ## Placement section";
    } catch (e) { placementDetail = `read error: ${e.message}`; }
  }
  check("placement-section", hasPlacement, placementDetail);
}

// Source revision (stale-ground mechanism): the block names the revision its
// evidence was read or built at, so the figures in the artifact can be traced to
// the tree that produced them. Missing or malformed is a structural failure; a
// well-formed sha that no known repo can resolve is a warning, because a seat run
// from an unrelated CWD must still accept a valid result.
const SOURCE_REVISION_RE = /^[0-9a-f]{7,40}$/i;
// The repositories a revision may live in, in the order they are tried, each with
// the label a WARN prints. The set is data: a checkout cannot know where a machine
// keeps its other checkouts, and a repository's own default that names one machine's
// private tree is a clone that resolves nothing.
//
//   --repo <path>            the caller's own answer, tried first
//   BRAID_GATE_REPOS         colon-separated; the machine's list, supplied by the
//                            forwarder that keeps an old command working
//   $PWD                     the close usually runs where the work ran
//   this file's own checkout  so a gate invoked from inside a checkout resolves that
//                            checkout without being told
const shortenHome = (p) => resolve(p).replace(homedir(), "~");
const SOURCE_REPOS = (() => {
  const repos = [];
  const seen = new Set();
  const add = (label, dir) => {
    const full = resolve(dir);
    if (seen.has(full)) return;
    seen.add(full);
    repos.push([label, full]);
  };
  for (const dir of EXTRA_REPOS) add(shortenHome(dir), dir);
  for (const dir of (process.env.BRAID_GATE_REPOS ?? "").split(":")) {
    if (dir.trim() !== "") add(shortenHome(dir.trim()), dir.trim());
  }
  add("$PWD", process.cwd());
  const own = spawnSync("git", ["-C", import.meta.dirname, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (own.status === 0 && own.stdout.trim() !== "") add("this checkout", own.stdout.trim());
  return repos;
})();
// Set when source_revision resolves: the census check below must read the repo
// that owns the stamped revision, and `--repo pi-braid` is a label, not a path.
let censusRepoDir = null;
const rawRevision = schema.source_revision;
const sourceRevision = typeof rawRevision === "string" ? rawRevision.trim() : "";
if (!SOURCE_REVISION_RE.test(sourceRevision)) {
  const detail =
    sourceRevision === ""
      ? "missing or empty"
      : `not a 7-40 hex sha: ${String(rawRevision).slice(0, 40)}`;
  check("source-revision", false, detail);
} else {
  const tried = [];
  const seenDirs = new Set();
  let resolvedIn = null;
  let resolvedDir = null;
  censusRepoDir = null;
  for (const [label, dir] of SOURCE_REPOS) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    tried.push(label);
    const r = spawnSync("git", ["-C", dir, "cat-file", "-e", `${sourceRevision}^{commit}`], { encoding: "utf8" });
    if (r.status === 0) {
      resolvedIn = label;
      resolvedDir = dir;
      censusRepoDir = dir;
      break;
    }
  }
  // Resolution is the rule, not the shape. A revision no repository holds
  // cannot attest the tree its evidence was read at: the block's figures are
  // then traceable to nothing, and accepting it on 7-to-40 hex characters is an
  // acceptance of the only thing a forger has to get right. The remedy is named
  // because the common cause is a real revision in a repository the gate was not
  // told about, not a fabricated one.
  check(
    "source-revision",
    resolvedIn !== null,
    resolvedIn !== null
      ? `resolved in ${resolvedIn}`
      : `unresolved: no repository the gate searched holds ${sourceRevision} (tried ${tried.join(", ")}), ` +
        "and a revision that does not exist cannot attest the tree its evidence was read at — " +
        "pass --repo <path> for the repository it lives in",
  );

  // A revision that RESOLVES can still be one the tree has moved past, and an
  // artifact whose ground moved is then consumed as if nothing had changed.
  // Report-only by default: the drift is named in the close transcript so the
  // seat sees what moved without every existing close turning red. Pass
  // --strict-staleness (for impl/verify closes) to make drift a failure.
  const stalenessGate = join(import.meta.dirname, "check-artifact-staleness.mjs");
  if (resolvedDir && !existsSync(stalenessGate)) {
    // The pair is one unit in this repository; a lone copy of this file has no
    // freshness read at all, and a skipped read that says nothing reads as a pass.
    console.log(
      `WARN source-revision-freshness: the sibling gate is not beside this script (${stalenessGate}), so the freshness read did not run`,
    );
  }
  if (resolvedDir && existsSync(stalenessGate)) {
    const args = [stalenessGate, "--repo", resolvedDir, "--revision", sourceRevision];
    if (STRICT_STALENESS) args.push("--strict");
    const s = spawnSync(process.execPath, args, { encoding: "utf8" });
    const lines = `${s.stdout ?? ""}${s.stderr ?? ""}`.trim().split("\n").filter(Boolean);
    const verdict = (lines.at(-1) ?? "(no output)").slice(0, 180);
    const moved = lines.find((l) => l.includes("file(s) since"))?.trim() ?? "";
    if (s.status === 0) {
      check("source-revision-freshness", true, moved.replace(/^\s*/, "") || verdict);
    } else if (s.status === 1 && !STRICT_STALENESS) {
      // Exit 1 with --strict off means the revision is not an ancestor of HEAD.
      // At close time that is the NORMAL shape: a block names its own commit,
      // which is not in HEAD until it is merged. Report-only mode therefore
      // passes with the fact stated, and --strict-staleness is the seat's
      // instrument for consuming an artifact as evidence after its revision
      // was expected to land.
      check("source-revision-freshness", true, `unmerged or foreign revision (report-only): ${verdict}`.slice(0, 200));
    } else {
      const failed = lines.filter((l) => l.startsWith("FAIL"));
      check("source-revision-freshness", false, `${failed.at(-1) ?? verdict}`.slice(0, 200));
    }
  }
}

// Claim predictions (`predicts`): an optional per-claim string naming the
// instrument and the observation it makes if the claim holds. The heuristic is
// deliberately lenient — >= 20 characters and one of the markers below (mostly
// words, so matched case-insensitively) — because it gates a WARN, not a
// failure. Presence is instrumented now so coverage is visible; a block written
// before the field existed (or with a weak prediction) stays valid and only
// prints a warning.
const PREDICTS_MARKERS = ["->", "=", "shows", "returns", "exits", "count", "bytes", "lines"];
function predictsOk(p) {
  if (typeof p !== "string" || p.trim().length < 20) return false;
  const lower = p.toLowerCase();
  return PREDICTS_MARKERS.some((m) => (m === "->" || m === "=" ? p.includes(m) : lower.includes(m)));
}
let predictsCovered = 0;
let predictsInvalid = 0;
for (const c of claimEntries) {
  if (!c || typeof c !== "object" || !("predicts" in c)) continue;
  if (predictsOk(c.predicts)) predictsCovered++;
  else predictsInvalid++;
}
const predictsMissing = claimEntries.length - predictsCovered - predictsInvalid;

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  if (!r.ok) failed++;
}
// Gate-evidence sampleability: gate-sampler.mjs re-runs entries shaped
// {cmd, exit_code|exit}; string-shaped entries pass this validator but cannot
// be sampled at all. Instrumented as a WARN so the gap is visible without
// turning previously-valid blocks into failures.
const gateEntries = Array.isArray(schema.gate_evidence) ? schema.gate_evidence : [];
const sampleable = gateEntries.filter(sampleableGate).length;
if (gateEntries.length > 0 && sampleable === 0)
  console.log(`WARN gate-evidence: 0/${gateEntries.length} entries carry {cmd, exit_code} — gate-sampler cannot sample this block`);
else if (sampleable < gateEntries.length)
  console.log(`gate-evidence-sampleable: ${sampleable}/${gateEntries.length}`);

// Population-stamp read over every row. A row whose command carries a walk,
// list or count verb is a population scan, and any row whose stamp is present
// but not the contract's shape carries no readable record either. Both are the
// same defect at the merge path, which compares a stamped row's number against
// the census the revision it names holds: a row it cannot read is a population
// it cannot test, and the block then asserts a count nothing can check.
//
// The refusal keys on the block's own claim: a `completed` block says the work
// finished, so an unreadable population record is a finished result with an
// untestable figure. Under `partial`, `blocked` or `error` the same row is only
// a warning — an incomplete result is allowed to say what it does not know. The
// counter line prints in both cases: it is the measurement surface, and it must
// not vanish when the family turns red.
let recognizedRows = 0;
let recognizedStamped = 0;
const unreadableStamps = [];
const stampWarnings = [];
for (let i = 0; i < gateEntries.length; i++) {
  const row = gateEntries[i];
  const record = row && typeof row === "object" && !Array.isArray(row) ? row : null;
  const hasStamp = record !== null && record.stamp !== undefined;
  const parsed = hasStamp ? parsePopulationStamp(record.stamp) : null;
  if (hasStamp && parsed === null) {
    unreadableStamps.push(i);
    stampWarnings.push(
      `WARN gate-evidence stamp: row ${i} (cmd: ${commandExcerpt(record.cmd)}) carries an unparseable stamp: ` +
        `${JSON.stringify(record.stamp)} — expected "scanned <n> <unit> at <revision>"`,
    );
    continue;
  }
  const verbs = populationVerbsIn(record?.cmd);
  if (verbs.length === 0) continue;
  recognizedRows++;
  if (parsed) {
    recognizedStamped++;
    continue;
  }
  unreadableStamps.push(i);
  stampWarnings.push(
    `WARN gate-evidence stamp: row ${i} (cmd: ${commandExcerpt(record.cmd)}) is a population scan ` +
      `(${verbs.join(", ")}) with no stamp — record "scanned <n> <unit> at <revision>" ` +
      "so verify-and-merge can compare it against the census that revision names",
  );
}
// The census comparison. A stamp is only useful if its number is the census of
// the revision it names, and the failure this reads is a worker stamping the
// population it touched: 12 changed files recorded where 1056 entries are
// tracked. verify-and-merge refuses that, but it refuses at the end, after the
// merge attempt and a re-issue; catching it here costs one line and saves the
// round trip. The repo's own tracked-file count is the instrument, read through
// git so it agrees with what the merge path will compute.
if (censusRepoDir) {
  // The flag arrives as text (`--repo pi-braid`), not a path, and resolving it
  // as one points at a directory that does not exist. The repo that actually
  // resolved the stamped revision is the one whose census matters, which is why
  // this reads what the source-revision pass found rather than the raw flag.
  // Skipping that step is why the first version of this check was silent on the
  // very case that motivated it.
  const repoDir = censusRepoDir;
  // The census belongs to the revision the stamp names, not to the working tree:
  // a branch that adds five files has 1061 entries where main has 1056, and both
  // numbers are right for their own revision. Reading the tree instead of the
  // object is the mistake that made the first version of this check warn on a
  // correct stamp, so the count comes from `ls-tree` at the stamped revision.
  const censusAt = (revision) => {
    const run = spawnSync("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", revision], { encoding: "utf8" });
    return run.status === 0 ? run.stdout.split("\n").filter(Boolean).length : 0;
  };
  for (let i = 0; i < gateEntries.length; i++) {
    const row = gateEntries[i];
    const record = row && typeof row === "object" && !Array.isArray(row) ? row : null;
    if (!record || record.stamp === undefined) continue;
    const parsed = parsePopulationStamp(record.stamp);
    if (!parsed || typeof parsed.n !== "number") continue;
    const tracked = censusAt(parsed.revision);
    if (tracked === 0) continue;
    if (parsed.n === tracked) continue;
    stampWarnings.push(
      `WARN gate-evidence census: row ${i} (cmd: ${commandExcerpt(record.cmd)}) stamps ${parsed.n} ` +
        `but ${repoDir} tracks ${tracked} entries at ${parsed.revision} — a stamp records the census of the revision it names, ` +
        "not the number of files the change touched; verify-and-merge refuses the mismatch",
    );
  }
}
for (const line of stampWarnings) console.log(line);
if (recognizedRows > 0)
  console.log(
    `gate-evidence-stamps: ${recognizedStamped}/${recognizedRows} recognized scan row(s) carry a parseable stamp`,
  );
if (unreadableStamps.length > 0 && schema.status === "completed") {
  failed++;
  console.log(
    `FAIL gate-evidence-stamps: ${unreadableStamps.length} row(s) of this completed block carry no readable population record ` +
      `(row ${unreadableStamps.join(", ")}), and a finished result may not leave a population it scanned untestable — ` +
      'the record is "scanned <n> <unit> at <revision>": n a non-negative integer, unit ONE lowercase word ' +
      "(hyphens or underscores join a unit; a space or a path inside it is unreadable), revision a 7-40 char hex sha " +
      "or a ref name, and the whole string is the stamp",
  );
}

// Red-evidence pairing. A RED row asserts that a test failed for the intended
// reason, and a tree that was never compiled cannot support that assertion: a
// package that builds to dist reverts in source and still passes until the
// compiler runs, so a revert reported with no build row beside it is the shape
// this reads. Warn tier first, on the same convention as the stamp contract:
// the counter line is the measurement surface, and the flip to a refusal waits
// until the seat has read the share. Only object rows are read, for the same
// reason the stamp read skips the rest.
const RED_ROW_RE = /\bred\b|revert|mutant|planted|mutation/i;
const BUILD_ROW_RE = /\btsc\b|npm run (?:build|typecheck|ci:check)|npx tsc|make \w+|cargo build|go build/i;
const rowCommands = gateEntries
  .map((row) => (row && typeof row === "object" && typeof row.cmd === "string" ? row.cmd : null))
  .filter((cmd) => cmd !== null);
const redRows = rowCommands.filter((cmd) => RED_ROW_RE.test(cmd));
const buildRows = rowCommands.filter((cmd) => BUILD_ROW_RE.test(cmd));
if (redRows.length > 0) {
  if (buildRows.length === 0) {
    console.log(
      `WARN gate-evidence red-build: ${redRows.length} red row(s) with no build or typecheck row — ` +
        "a mutant that never compiled passes for the wrong reason; record the build the RED ran against",
    );
  }
  console.log(
    `gate-evidence-red-build: ${buildRows.length > 0 ? redRows.length : 0}/${redRows.length} red row(s) paired with a build row`,
  );
}

if (predictsMissing > 0) console.log(`WARN predicts: ${predictsMissing} claim(s) without a prediction`);
if (unsourcedVerifier.length > 0) console.log(`WARN claims-verified-by-names: ${unsourcedVerifier.length} claim(s) whose verified_by names no artifact or command (advisory: the decidable case fails, this residue is the seat's re-derivation job)`);
if (predictsInvalid > 0) console.log(`WARN predicts: ${predictsInvalid} claim(s) carry a prediction failing the heuristic (>=20 chars, one of ${PREDICTS_MARKERS.join(" ")})`);
if (predictsMissing + predictsInvalid > 0) console.log(`predicts-covered: ${predictsCovered}/${claimEntries.length}`);

// Instrument-capability pairing read (D3/D4). Warn tier only: the exit code and
// every check above are untouched; the counter line is the measurement surface,
// and the design's refusal tier stays closed until the dry run's numbers and
// the seat's decision open it.
const capability = evaluateClaimCapability(claimEntries);
for (const line of capability.warnings) console.log(line);
if (capability.entries > 0) {
  const capabilityWarns = Object.values(capability.counts).reduce((sum, n) => sum + n, 0);
  const breakdown = Object.entries(capability.counts).map(([rule, n]) => `${rule} ${n}`).join(", ");
  console.log(`claim-capability: ${capability.read}/${capability.entries} checked, ${capabilityWarns} warn(s) (${breakdown})`);
}

// Instrument disclosure (the self-review store's most frequent class). A claim
// that states a figure has to name the instrument behind it, or the figure is
// unverifiable by a reader and was unverifiable for the claimant too.
//
// Two tiers, both keyed on what the block claims about itself. A `completed`
// block attests a finished result, so every figure it states must name its
// command: that is a refusal. Under `partial`, `blocked` or `error` the same
// claim stays a warning, because an incomplete result is allowed to say what it
// does not know — and `--fail-on-instrument` raises that tier too, for a caller
// who wants one rule whatever the status. Completion, not the spec kind, is the
// line: a research close and an impl close both state finished facts, and one
// worker can produce either.
const disclosureEnforced = INSTRUMENT_ENFORCED || schema.status === "completed";
const disclosure = evaluateInstrumentDisclosure(claimEntries);
for (const finding of disclosure.findings) console.log(instrumentWarningLine(finding));
if (disclosure.withFigure > 0) {
  console.log(
    `instrument-disclosure: ${disclosure.withFigure}/${disclosure.entries} claim(s) carry a figure, ` +
      `${disclosure.findings.length} without a command` +
      (disclosureEnforced ? " (enforced)" : " (advisory: status is not completed, and --fail-on-instrument is off)"),
  );
}
if (disclosure.findings.length > 0 && disclosureEnforced) {
  failed++;
  const why =
    schema.status === "completed"
      ? "a completed block attests a finished result, so every figure it states must name the instrument that produced it"
      : "--fail-on-instrument makes every figure name its instrument, whatever the status";
  console.log(
    `FAIL instrument-disclosure: ${disclosure.findings.length} claim(s) state a figure with no command — ${why} ` +
      "(name the command in verified_by, or in the claim's command field)",
  );
}

console.log(`\n${failed === 0 ? "RESULT: PASS" : `RESULT: ${failed} check(s) failed`} — worker=${schema.worker} spec=${schema.spec} status=${schema.status}`);
console.log(`output_file: ${schema.output_file}`);
process.exit(failed === 0 ? 0 : 1);
}

export { VERIFIER_CLASSES, CLAIM_CLASSES, COUNT_VERBS, DECOMPOSITION_WORDS, CENSUS_SUGGESTION, evaluateClaimCapability, evaluateInstrumentDisclosure, MEASURED_FIGURE_RE };

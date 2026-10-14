/**
 * Corpus runner — replays the review's adversarial Telegram-format corpus
 * (test/fixtures/telegram-format-corpus.mjs) through the package and asserts
 * the wire contract:
 *
 *   1. every chunk the sender would emit stays under Telegram's 4096 cap;
 *   2. every chunk that ships with parseMode HTML is one Telegram accepts
 *      (local checker), unless the baseline already recorded that case and
 *      mode as invalid — no fix may introduce a NEW rejection;
 *   3. every recorded live verdict for an HTML wire matches the checker
 *      (the checker-vs-live agreement the review demanded);
 *   4. the 21-cell `{requested} × {body}` matrix still resolves exactly as the
 *      review recorded it;
 *   5. the cap-crossing bodies (R2/F8) keep their named wire contract: a
 *      refused conversion ships the authored body in one capped message, a
 *      tag-aware split keeps every HTML chunk parseable;
 *   6. the set of cases whose delivered wire changed against the recorded
 *      baseline equals EXPECTED_FIDELITY_CHANGES exactly.
 *
 * Run standalone after a build (`node test/corpus-runner.mjs`; `npm test`
 * builds first) or via test/corpus.test.mjs. Exit code 1 on any violation.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTelegramHtml } from "../dist/lib/html-check.js";
import {
  resolveDeliveryFormat,
  sendMessageChunks,
  TELEGRAM_MAX_TEXT_LENGTH,
} from "../dist/lib/format.js";
import { runTelegramSend } from "../dist/lib/tool-logic.js";
import {
  CAP_CASES,
  EXPECTED_FIDELITY_CHANGES,
  HOSTILE_CASES,
  HTML_PARSE_CASES,
  MATRIX_BODIES,
  MATRIX_CELLS,
  VERDICT_WIRES,
} from "./fixtures/telegram-format-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "telegram-format-baseline.json"),
    "utf8",
  ),
);
const BOT_TOKEN = "test:token";
const OWNER_CHAT_ID = 4242;
const CAPTURE_MAX = 100_000;

/** Client whose sendMessage records the exact bodies the wire would carry. */
function capturingClient() {
  const calls = [];
  return {
    calls,
    client: {
      sendMessage: async (token, chatId, text, options = {}) => {
        calls.push({ text, options });
        return { ok: true, messageId: 1000 + calls.length };
      },
      sendVoiceNote: async () => ({ ok: true, messageId: 1 }),
    },
  };
}

/** The wire a resolved delivery would produce (marker reservation included). */
async function wireOf(format) {
  const { client, calls } = capturingClient();
  const result = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: format.text,
    ...(format.parseMode ? { parseMode: format.parseMode } : {}),
    maxLen: CAPTURE_MAX,
  });
  return { chunks: calls.map((c) => c.text), total: result.total };
}

export async function runCorpus() {
  const failures = [];
  const notes = [];
  const modeLabel = (requested) =>
    requested === undefined ? "none" : requested;

  // ── 1-3. hostile corpus: wire validity + baseline fidelity ───────────────
  let changedModePairs = 0;
  const observedChanges = new Map(); // name → Set(modeLabel)
  let htmlWires = 0;
  let preExistingInvalid = 0;
  for (const { name, body } of HOSTILE_CASES) {
    const baseline = BASELINE.cases[name];
    if (!baseline) {
      failures.push(`baseline missing for case ${JSON.stringify(name)}`);
      continue;
    }
    for (const requested of [undefined, "Markdown", "HTML"]) {
      const format = resolveDeliveryFormat(requested, body);
      const label = modeLabel(requested);
      const { chunks } = await wireOf(format);
      const base = baseline.find((entry) => entry.requested === label);
      const preInvalid =
        base.mode === "HTML" && !checkTelegramHtml(base.text).ok;
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.length > TELEGRAM_MAX_TEXT_LENGTH) {
          failures.push(
            `${name} [${label}] chunk ${index + 1} is ${chunk.length} > ${TELEGRAM_MAX_TEXT_LENGTH}`,
          );
        }
        if (format.parseMode === "HTML") {
          htmlWires++;
          const verdict = checkTelegramHtml(chunk);
          if (!verdict.ok) {
            if (preInvalid) {
              preExistingInvalid++;
              notes.push(
                `${name} [${label}] HTML wire invalid before and after (pre-existing): ${verdict.error}`,
              );
            } else {
              failures.push(
                `${name} [${label}] HTML wire REJECTED but baseline was valid: ${verdict.error}\n    ${JSON.stringify(chunk)}`,
              );
            }
          }
        }
      }
      const changed =
        base.mode !== (format.parseMode ?? "plain") ||
        base.text !== format.text;
      if (changed) {
        changedModePairs++;
        if (!observedChanges.has(name)) observedChanges.set(name, new Set());
        observedChanges.get(name).add(label);
      }
    }
  }

  // ── 4. live verdicts replayed against the local checker ──────────────────
  let verdictRows = 0;
  for (const { name, wire, parseMode, verdict } of VERDICT_WIRES) {
    if (parseMode !== "HTML") continue; // Markdown/MarkdownV2: probe-only
    verdictRows++;
    const local = checkTelegramHtml(wire);
    const expectedOk = verdict === "PARSES";
    if (local.ok !== expectedOk) {
      failures.push(
        `checker disagrees with live verdict for ${JSON.stringify(name)}: live=${verdict}, local=${local.ok ? "PARSES" : `REJECTED (${local.error})`}`,
      );
    }
  }

  // ── 5. the resolution matrix ─────────────────────────────────────────────
  for (const [requested, key, mode, text, converted] of MATRIX_CELLS) {
    const r = resolveDeliveryFormat(requested, MATRIX_BODIES[key]);
    const label = `requested=${modeLabel(requested)} body=${key}`;
    if ((r.parseMode ?? undefined) !== mode) {
      failures.push(
        `matrix ${label}: mode ${String(r.parseMode)} != ${String(mode)}`,
      );
    }
    if (r.text !== text) {
      failures.push(
        `matrix ${label}: text ${JSON.stringify(r.text)} != ${JSON.stringify(text)}`,
      );
    }
    const conv = r.converted ?? undefined;
    if (JSON.stringify(conv) !== JSON.stringify(converted)) {
      failures.push(
        `matrix ${label}: converted ${JSON.stringify(conv)} != ${JSON.stringify(converted)}`,
      );
    }
  }

  // ── 6. cap-crossing bodies (R2/F8) ───────────────────────────────────────
  for (const capCase of CAP_CASES) {
    const { client, calls } = capturingClient();
    const outcome = await runTelegramSend(capCase.params, {
      client,
      token: BOT_TOKEN,
      chatId: OWNER_CHAT_ID,
      ...capCase.deps,
    });
    if (!outcome.ok) {
      failures.push(`cap ${capCase.name}: send failed (${outcome.error})`);
      continue;
    }
    const expect = capCase.expect;
    if (expect.sends !== undefined && calls.length !== expect.sends) {
      failures.push(
        `cap ${capCase.name}: ${calls.length} sends, expected ${expect.sends}`,
      );
    }
    if (expect.minSends !== undefined && calls.length < expect.minSends) {
      failures.push(
        `cap ${capCase.name}: ${calls.length} sends, expected at least ${expect.minSends}`,
      );
    }
    for (const call of calls) {
      if (call.text.length > expect.maxChars) {
        failures.push(
          `cap ${capCase.name}: wire ${call.text.length} chars over cap ${expect.maxChars}`,
        );
      }
      if (call.options.parseMode !== expect.parseMode) {
        failures.push(
          `cap ${capCase.name}: parseMode ${String(call.options.parseMode)} != ${String(expect.parseMode)}`,
        );
      }
      if (expect.htmlValid) {
        const verdict = checkTelegramHtml(call.text);
        if (!verdict.ok) {
          failures.push(
            `cap ${capCase.name}: HTML chunk rejected: ${verdict.error}`,
          );
        }
      }
    }
  }

  // ── 7. fidelity change set ───────────────────────────────────────────────
  const expected = new Map(
    EXPECTED_FIDELITY_CHANGES.map((entry) => [
      entry.name,
      { modes: new Set(entry.modes.map(modeLabel)), reason: entry.reason },
    ]),
  );
  for (const [name, modes] of observedChanges) {
    const want = expected.get(name);
    if (!want) {
      failures.push(
        `unexpected fidelity change for ${JSON.stringify(name)}: ${[...modes].join(", ")}`,
      );
      continue;
    }
    for (const mode of modes) {
      if (!want.modes.has(mode)) {
        failures.push(
          `fidelity change for ${JSON.stringify(name)} in unexpected mode ${mode}`,
        );
      }
    }
  }
  for (const [name, want] of expected) {
    const got = observedChanges.get(name);
    if (!got) {
      failures.push(
        `expected fidelity change for ${JSON.stringify(name)} did not happen (${want.reason})`,
      );
      continue;
    }
    for (const mode of want.modes) {
      if (!got.has(mode)) {
        failures.push(
          `expected fidelity change for ${JSON.stringify(name)} in mode ${mode} did not happen (${want.reason})`,
        );
      }
    }
  }

  return {
    counts: {
      hostileCases: HOSTILE_CASES.length,
      modes: 3,
      htmlWires,
      preExistingInvalid,
      changedModePairs,
      verdictRows,
      matrixCells: MATRIX_CELLS.length,
      capCases: CAP_CASES.length,
      htmlParseCases: HTML_PARSE_CASES.length,
      expectedChanges: EXPECTED_FIDELITY_CHANGES.length,
    },
    failures,
    notes,
  };
}

/** Replay of the checker calibration corpus against the recorded live verdicts. */
export function runHtmlParseCorpus() {
  const failures = [];
  for (const { name, body, verdict } of HTML_PARSE_CASES) {
    const local = checkTelegramHtml(body);
    const expectedOk = verdict === "PARSES";
    if (local.ok !== expectedOk) {
      failures.push(
        `${name}: live=${verdict}, local=${local.ok ? "PARSES" : `REJECTED (${local.error})`} ${JSON.stringify(body)}`,
      );
    }
  }
  return { cases: HTML_PARSE_CASES.length, failures };
}

const isMain = process.argv[1] && process.argv[1].endsWith("corpus-runner.mjs");
if (isMain) {
  const report = await runCorpus();
  const parse = runHtmlParseCorpus();
  for (const note of report.notes) console.log(`note: ${note}`);
  console.log(
    `corpus: hostile=${report.counts.hostileCases} × ${report.counts.modes} modes, ` +
      `html-wires=${report.counts.htmlWires} (pre-existing-invalid=${report.counts.preExistingInvalid}), ` +
      `changed=${report.counts.changedModePairs} mode-pairs (${report.counts.expectedChanges} named cases), ` +
      `verdict-wires=${report.counts.verdictRows}, matrix=${report.counts.matrixCells}, ` +
      `caps=${report.counts.capCases}, html-parse=${parse.cases}`,
  );
  const failures = [...report.failures, ...parse.failures];
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) {
    console.error(`corpus runner: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("corpus runner: PASS");
}

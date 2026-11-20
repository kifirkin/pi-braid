/**
 * A provider's three shapes decide how a turn ends, and none of them can be
 * summoned from a paid endpoint on request: a 429 before the answer, a stream
 * that stops before `[DONE]`, and a normal answer assembled from deltas.
 * `scripts/emulated-provider.mjs` serves all three locally;
 *
 * WHY THIS TEST EXISTS:
 *   A server nobody drives proves nothing. This fixture starts the emulator,
 *   points the real pi runtime at it through the same `models.json` provider
 *   block LOCAL_DEV.md tells a human to paste, sends one prompt over RPC, and
 *   reads what the turn became. Nothing on pi's side is stubbed: the client is
 *   its `openai-completions` transport, its retry helper and its stream
 *   assembler, reached over a real socket. The far end is the only lie.
 *
 * WHAT IS PINNED HERE:
 *   1. Normal answer: one request, the prompt and `apiKey` reaching the wire,
 *      `stream_options.include_usage` set, text assembled from more than one
 *      delta, stopReason `stop`.
 *   2. Retry on 429: with `retry.provider.maxRetries` set, the wire sees
 *      429 then 200 and the turn still stops cleanly with the whole answer.
 *   3. The same 429 with no provider retry setting fails the turn after one
 *      request. This is what makes the setting in LOCAL_DEV.md load-bearing
 *      rather than decorative.
 *   4. A stream that stops before `[DONE]`: content arrives, no finish_reason
 *      and no terminal sentinel, and the turn is an error carrying the partial
 *      text. End of body is not end of answer.
 *
 * WHAT IS NOT COVERED:
 *   Braid's extensions are not loaded. With `-e dist/index.js` a nested RPC
 *   session produced one watchdog `setStatus` event and no provider request in
 *   90 seconds, so an arm that loaded them would pin braid's startup instead
 *   of this server. The transport here is pi's, which is the one braid runs on;
 *   for the manual equivalent, see the LOCAL_DEV.md section on this emulator.
 *
 * The `retry` count has no default, so the two 429 arms differ only in the
 * settings file they write. That pair is the point: one is the behaviour, the
 * other is what happens without the knob.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  modelsJson,
  settingsJsonFor,
  startEmulatedProvider,
} from "../../../scripts/emulated-provider.mjs";

const REPLY = "the emulated provider replied";
/** Per-arm bound. Four arms at this cap stay inside the runner's 60s default. */
const ARM_CAP_MS = 12_000;
const PROMPT = "say hello";

/** pi's own RPC entry, resolved through the package export map the repo pins. */
const PI_RPC_ENTRY = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
);

/** The text blocks of an assistant message, joined as a reader would see them. */
function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Run one prompt through pi against the emulated provider and return what the
 * turn became. The child gets its own HOME and agent directory, so no settings
 * or session from the real agent tree can reach it, and it is killed on every
 * path: a pi that outlived its arm would keep the fixture's stdout pipe open
 * and be reported as a timeout rather than the failure it was.
 */
async function runTurn({ mode, settings = settingsJsonFor(mode), failures = 1 }) {
  assert.ok(
    existsSync(PI_RPC_ENTRY),
    `pi's RPC entry is missing at ${PI_RPC_ENTRY}: run npm install at the repo root`,
  );

  const emulated = await startEmulatedProvider({ mode, failures, reply: REPLY });
  const home = mkdtempSync(join(tmpdir(), `emulated-provider-${mode}-`));
  const agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
  // The two files a human writes, written here by the same functions that
  // print them, so the documented config and the tested config are one config.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(emulated), null, 2));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));

  const child = spawn(
    process.execPath,
    [
      PI_RPC_ENTRY,
      "--no-session",
      "--no-extensions",
      "--tools",
      "",
      "--provider",
      "emulated",
      "--model",
      emulated.model,
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        BRAID_HOME: join(home, "braid"),
        // pi's startup network operations are not what this fixture measures,
        // and with the box's link down each arm paid a connect timeout before
        // it ever reached the emulator (4s an arm against 0.8s here). Offline
        // keeps the arm's duration a property of this server.
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let buffered = "";
  const events = [];
  let assistant = null;

  const exited = new Promise((resolve) => child.once("exit", resolve));
  const settled = new Promise((resolve) => {
    child.once("exit", resolve);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (!line.startsWith("{")) {
          continue;
        }
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // A line that starts with `{` and is not JSON is a startup banner,
          // not an event: keep reading, the assertion is on the events.
          continue;
        }
        events.push(event);
        if (event.type === "extension_ui_request") {
          // An RPC client owes every UI request an answer; these are status
          // notifications, and cancelling one changes nothing.
          child.stdin.write(
            `${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`,
          );
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          assistant = event.message;
        }
        if (event.type === "agent_end") {
          resolve();
        }
      }
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let capTimer;
  const capped = new Promise((_, reject) => {
    capTimer = setTimeout(() => {
      reject(
        new Error(
          `${mode} arm reached no agent_end in ${ARM_CAP_MS}ms; ` +
            `${emulated.requests.length} request(s) reached the emulator, ` +
            `${events.length} event(s) were read; stderr: ${stderr.trim() || "(empty)"}`,
        ),
      );
    }, ARM_CAP_MS);
  });

  try {
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: PROMPT })}\n`);
    await Promise.race([settled, capped]);
  } finally {
    clearTimeout(capTimer);
    child.kill("SIGKILL");
    await exited;
    await emulated.stop();
    rmSync(home, { recursive: true, force: true });
  }

  return {
    model: emulated.model,
    requests: emulated.requests,
    assistant,
    events,
  };
}

test("a normal answer is assembled from the deltas the provider streamed", async () => {
  const turn = await runTurn({ mode: "normal" });

  assert.equal(turn.requests.length, 1, "one prompt is one request");
  assert.equal(turn.requests[0].status, 200);
  const body = turn.requests[0].body;
  assert.equal(body.model, turn.model, "the model id from models.json reached the wire");
  assert.equal(body.stream, true);
  assert.equal(
    body.stream_options?.include_usage,
    true,
    "pi asks for streaming usage, which the emulator's usage chunk answers",
  );
  assert.ok(
    JSON.stringify(body.messages).includes(PROMPT),
    `the prompt reached the wire; body was ${JSON.stringify(body.messages).slice(0, 200)}`,
  );
  assert.equal(
    turn.requests[0].headers.authorization,
    "Bearer emulated",
    "the apiKey from models.json resolved to a bearer header",
  );

  assert.equal(turn.assistant?.stopReason, "stop", "a complete answer stops the turn");
  assert.equal(
    textOf(turn.assistant),
    REPLY,
    "the answer is the whole reply, not the first or last delta",
  );
});

test("a 429 is absorbed inside one turn when provider retry is configured", async () => {
  const turn = await runTurn({ mode: "retry", failures: 1 });

  assert.deepEqual(
    turn.requests.map((request) => request.status),
    [429, 200],
    "the wire shows the refusal and the retry that answered it",
  );
  assert.equal(turn.assistant?.stopReason, "stop", "the retried answer completes the turn");
  assert.equal(
    textOf(turn.assistant),
    REPLY,
    "the retried answer is assembled whole, not merged with the failed attempt",
  );
});

test("the same 429 fails the turn when no provider retry is configured", async () => {
  const turn = await runTurn({ mode: "retry", failures: 1, settings: {} });

  assert.equal(turn.requests.length, 1, "nothing retried it at the provider layer");
  assert.equal(turn.assistant?.stopReason, "error", "the refusal is the turn's outcome");
  assert.match(
    turn.assistant?.errorMessage ?? "",
    /429/,
    `the failure names the status it was refused with; got "${turn.assistant?.errorMessage}"`,
  );
});

test("a stream that stops before [DONE] is never a completed answer", async () => {
  const turn = await runTurn({ mode: "truncated" });

  assert.equal(
    turn.requests.length,
    1,
    "the documented settings keep an uncompletable turn from being re-attempted",
  );
  assert.equal(
    turn.assistant?.stopReason,
    "error",
    "end of body without a finish_reason is an error, not a stop",
  );
  assert.notEqual(
    textOf(turn.assistant),
    "",
    "the deltas that did arrive are still carried by the failed message",
  );
  assert.notEqual(textOf(turn.assistant), REPLY, "the reply never completed");
  assert.ok(
    REPLY.startsWith(textOf(turn.assistant)),
    `the carried text is a prefix of the reply; got "${textOf(turn.assistant)}"`,
  );
  assert.ok(
    (turn.assistant?.errorMessage ?? "").length > 0,
    "the failure is named rather than left empty",
  );
});

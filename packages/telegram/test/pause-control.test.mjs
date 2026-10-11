/**
 * pause-control.test.mjs — inline-keyboard pause/resume control:
 * keyboard builder, persisted state (atomic write-temp-rename), getPauseState,
 * sendControlKeyboard, and the callback_query handler (pause/resume/status →
 * answerCallbackQuery + editMessageText keyboard refresh). All through a
 * recorded fake client with temp state files. NO network.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildControlKeyboard,
  loadPauseState,
  savePauseState,
  getPauseState,
  sendControlKeyboard,
  placeControlKeyboard,
  handlePauseCallbackQuery,
  CALLBACK_PAUSE,
  CALLBACK_RESUME,
  CALLBACK_STATUS,
  CONTROL_RUNNING_TEXT,
  CONTROL_PAUSED_TEXT,
} from "../dist/lib/pause-control.js";

import { makeCallbackUpdate } from "./fixtures.mjs";

let dir;
let stateFile;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-pause-"));
  stateFile = join(dir, "pause-state.json");
});

/** Fake client: records every call, honors failMethod(fn) to force a failure. */
function makeFakeClient({ failAnswer = false, failEdit = false } = {}) {
  const calls = [];
  const client = {
    calls,
    async answerCallbackQuery(_token, cqId, opts) {
      calls.push({ method: "answerCallbackQuery", cqId, opts });
      return failAnswer ? { ok: false, error: "answer boom" } : { ok: true };
    },
    async editMessageText(_token, chatId, messageId, text, opts) {
      calls.push({ method: "editMessageText", chatId, messageId, text, opts });
      return failEdit
        ? { ok: false, error: "edit boom" }
        : { ok: true, messageId };
    },
    async sendMessage(_token, chatId, text, opts) {
      calls.push({ method: "sendMessage", chatId, text, opts });
      return { ok: true, messageId: 900 };
    },
  };
  return client;
}

function deps(client) {
  return { client, token: "T", stateFile, log: () => {} };
}

function pauseCalls(calls, method) {
  return calls.filter((c) => c.method === method);
}

// ── Keyboard builder ────────────────────────────────────────────────────────

test("buildControlKeyboard: running shows Pause + Status; paused shows Resume + Status", () => {
  assert.deepEqual(buildControlKeyboard(false), {
    inline_keyboard: [
      [
        { text: "⏸ Pause", callback_data: CALLBACK_PAUSE },
        { text: "📊 Status", callback_data: CALLBACK_STATUS },
      ],
    ],
  });
  assert.deepEqual(buildControlKeyboard(true), {
    inline_keyboard: [
      [
        { text: "▶ Resume", callback_data: CALLBACK_RESUME },
        { text: "📊 Status", callback_data: CALLBACK_STATUS },
      ],
    ],
  });
});

// ── State persistence ───────────────────────────────────────────────────────

test("loadPauseState: missing or corrupt file defaults to not-paused", async () => {
  assert.deepEqual(await loadPauseState(join(dir, "nope.json")), {
    paused: false,
    updatedAt: 0,
  });
  const corrupt = join(dir, "corrupt.json");
  await import("node:fs/promises").then((m) =>
    m.writeFile(corrupt, "{not json"),
  );
  assert.deepEqual(await loadPauseState(corrupt), {
    paused: false,
    updatedAt: 0,
  });
});

test("savePauseState: persists atomically (write-temp-rename), reloads cleanly", async () => {
  const state = { paused: true, updatedAt: 12345 };
  await savePauseState(stateFile, state);

  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), state);
  // Atomic: the temp file is renamed away — never left behind.
  assert.deepEqual(readdirSync(dir), ["pause-state.json"]);
  assert.deepEqual(await loadPauseState(stateFile), state);
});

test("getPauseState: exported read seam reflects persisted state (default not-paused)", async () => {
  assert.deepEqual(await getPauseState(stateFile), {
    paused: false,
    updatedAt: 0,
  });
  await savePauseState(stateFile, { paused: true, updatedAt: 7 });
  assert.deepEqual(await getPauseState(stateFile), {
    paused: true,
    updatedAt: 7,
  });
});

// ── sendControlKeyboard ─────────────────────────────────────────────────────

test("sendControlKeyboard: sends the status line with the inline keyboard attached", async () => {
  const client = makeFakeClient();
  const res = await sendControlKeyboard(client, "T", 111, false);

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 900);
  const send = pauseCalls(client.calls, "sendMessage");
  assert.equal(send.length, 1);
  assert.equal(send[0].chatId, 111);
  assert.equal(send[0].text, CONTROL_RUNNING_TEXT);
  assert.deepEqual(send[0].opts.replyMarkup.inline_keyboard[0][0], {
    text: "⏸ Pause",
    callback_data: CALLBACK_PAUSE,
  });
});

// ── placeControlKeyboard (poller-start placement seam) ────────────────────
// The orchestrator sends the control into the owner chat at poller start. This
// helper reads the CURRENT persisted pause flag and calls sendControlKeyboard;
// it is delivery-neutral (nothing self-sends on import) and DI-able. Proves the
// seam sends with the correct chatId AND paused state; defers (no send) when no
// chat id is known yet; reports failures without throwing.

test("placeControlKeyboard: sends the control to the chat with the RUNNING state (⏸ Pause button)", async () => {
  const client = makeFakeClient();
  const res = await placeControlKeyboard(111, {
    client,
    token: "T",
    getPauseState: async () => ({ paused: false, updatedAt: 0 }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.deferred, false);
  assert.equal(res.messageId, 900);
  const send = pauseCalls(client.calls, "sendMessage");
  assert.equal(send.length, 1);
  assert.equal(
    send[0].chatId,
    111,
    "correct chatId flows into sendControlKeyboard",
  );
  assert.equal(
    send[0].text,
    CONTROL_RUNNING_TEXT,
    "not-paused → running status line",
  );
  assert.deepEqual(send[0].opts.replyMarkup.inline_keyboard[0][0], {
    text: "⏸ Pause",
    callback_data: CALLBACK_PAUSE,
  });
});

test("placeControlKeyboard: paused reader → sends with the PAUSED state (▶ Resume button)", async () => {
  const client = makeFakeClient();
  const res = await placeControlKeyboard(222, {
    client,
    token: "T",
    getPauseState: async () => ({ paused: true, updatedAt: 99 }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.deferred, false);
  const send = pauseCalls(client.calls, "sendMessage");
  assert.equal(send.length, 1);
  assert.equal(send[0].chatId, 222);
  assert.equal(
    send[0].text,
    CONTROL_PAUSED_TEXT,
    "paused → paused status line + Resume primary button",
  );
  assert.deepEqual(send[0].opts.replyMarkup.inline_keyboard[0][0], {
    text: "▶ Resume",
    callback_data: CALLBACK_RESUME,
  });
});

test("placeControlKeyboard: default state reader (no DI) means not-paused (running keyboard)", async () => {
  const client = makeFakeClient();
  const res = await placeControlKeyboard(333, { client, token: "T" });
  assert.equal(res.ok, true);
  const send = pauseCalls(client.calls, "sendMessage");
  assert.equal(
    send[0].text,
    CONTROL_RUNNING_TEXT,
    "unwired reader ≡ never-paused → running keyboard",
  );
});

test("placeControlKeyboard: empty/zero chatId → deferred (no send), for the bootstrap deferral path", async () => {
  const client = makeFakeClient();
  for (const chatId of [undefined, "", 0]) {
    const res = await placeControlKeyboard(chatId, {
      client,
      token: "T",
      getPauseState: async () => ({ paused: true, updatedAt: 1 }),
    });
    assert.equal(res.ok, false);
    assert.equal(
      res.deferred,
      true,
      `deferred for chatId=${JSON.stringify(chatId)} — nothing sent`,
    );
  }
  assert.equal(
    pauseCalls(client.calls, "sendMessage").length,
    0,
    "no sendMessage when deferred",
  );
});

test("placeControlKeyboard: send failure is reported, never thrown (still not deferred)", async () => {
  const client = makeFakeClient();
  client.sendMessage = async () => ({ ok: false, error: "chat not found" });
  const res = await placeControlKeyboard(777, {
    client,
    token: "T",
    getPauseState: async () => ({ paused: false, updatedAt: 0 }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.deferred, false);
  assert.equal(res.error, "chat not found");
});

// ── Callback handler: pause / resume / status ───────────────────────────────

test("pause callback: persists paused=true, answers + edits keyboard to Resume", async () => {
  const client = makeFakeClient();
  const out = await handlePauseCallbackQuery(
    deps(client),
    makeCallbackUpdate(1, CALLBACK_PAUSE).callback_query,
  );

  assert.equal(out.ok, true);
  assert.equal(out.action, CALLBACK_PAUSE);
  assert.equal(out.paused, true);
  assert.equal(out.answered, true);
  assert.equal(out.edited, true);
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.paused, true);
  assert.ok(
    Number.isFinite(persisted.updatedAt),
    "transition timestamp persisted",
  );

  const answer = pauseCalls(client.calls, "answerCallbackQuery");
  assert.equal(answer.length, 1);
  assert.equal(answer[0].cqId, "cq-1");
  assert.equal(answer[0].opts.text, "⏸ Agent paused");

  const edit = pauseCalls(client.calls, "editMessageText");
  assert.equal(edit.length, 1);
  assert.equal(edit[0].text, CONTROL_PAUSED_TEXT);
  // Keyboard now offers Resume (the action that changes the current state).
  assert.deepEqual(edit[0].opts.replyMarkup.inline_keyboard[0][0], {
    text: "▶ Resume",
    callback_data: CALLBACK_RESUME,
  });
});

test("status callback: no state change, still answers + refreshes the keyboard", async () => {
  const client = makeFakeClient();
  const cq = makeCallbackUpdate(2, CALLBACK_STATUS).callback_query;
  const out = await handlePauseCallbackQuery(deps(client), cq);

  assert.equal(out.action, CALLBACK_STATUS);
  assert.equal(out.paused, false);
  assert.equal(out.answered, true);
  assert.equal(out.edited, true);
  assert.equal(
    existsSync(stateFile),
    false,
    "status must not create a state file",
  );
  const answer = pauseCalls(client.calls, "answerCallbackQuery");
  assert.equal(answer[0].opts.text, "▶ Agent running");
  const edit = pauseCalls(client.calls, "editMessageText");
  assert.equal(edit[0].text, CONTROL_RUNNING_TEXT);
});

test("resume callback: flips paused=true back to false", async () => {
  await savePauseState(stateFile, { paused: true, updatedAt: 5 });
  const client = makeFakeClient();
  const out = await handlePauseCallbackQuery(
    deps(client),
    makeCallbackUpdate(3, CALLBACK_RESUME).callback_query,
  );

  assert.equal(out.action, CALLBACK_RESUME);
  assert.equal(out.paused, false);
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.paused, false);
  assert.ok(persisted.updatedAt > 5, "transition timestamp advanced");
  const answer = pauseCalls(client.calls, "answerCallbackQuery");
  assert.equal(answer[0].opts.text, "▶ Agent running");
});

test("unknown action: answered with a hint, no state change, no keyboard edit", async () => {
  const client = makeFakeClient();
  const cq = makeCallbackUpdate(4, "delete_everything").callback_query;
  const out = await handlePauseCallbackQuery(deps(client), cq);

  assert.equal(out.action, "unknown");
  assert.equal(out.answered, true);
  assert.equal(out.edited, false);
  assert.equal(existsSync(stateFile), false);
  const answer = pauseCalls(client.calls, "answerCallbackQuery");
  assert.match(answer[0].opts.text, /Unknown action: delete_everything/);
  assert.equal(pauseCalls(client.calls, "editMessageText").length, 0);
});

test("idempotent re-tap: pause while already paused does not rewrite updatedAt", async () => {
  await savePauseState(stateFile, { paused: true, updatedAt: 10 });
  const client = makeFakeClient();
  const out = await handlePauseCallbackQuery(
    deps(client),
    makeCallbackUpdate(5, CALLBACK_PAUSE).callback_query,
  );

  assert.equal(out.paused, true);
  // updatedAt unchanged (10) — the no-op tap did not touch the state.
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    paused: true,
    updatedAt: 10,
  });
  assert.equal(out.answered, true); // still answered with the current state
  assert.equal(out.edited, true); // keyboard still refreshed
});

test("persistence across instances: a fresh handler reads the prior pause", async () => {
  const first = makeFakeClient();
  await handlePauseCallbackQuery(
    deps(first),
    makeCallbackUpdate(6, CALLBACK_PAUSE).callback_query,
  );

  // A brand-new handler with a fresh client still sees paused=true (file-based).
  const second = makeFakeClient();
  const out = await handlePauseCallbackQuery(
    deps(second),
    makeCallbackUpdate(7, CALLBACK_STATUS).callback_query,
  );
  assert.equal(out.paused, true);
  const answer = pauseCalls(second.calls, "answerCallbackQuery");
  assert.equal(answer[0].opts.text, "⏸ Agent paused");
});

test("tap without a message: still answers, skips the keyboard edit gracefully", async () => {
  const client = makeFakeClient();
  const cq = makeCallbackUpdate(8, CALLBACK_PAUSE, {
    dropMessage: true,
  }).callback_query;
  const out = await handlePauseCallbackQuery(deps(client), cq);

  assert.equal(out.paused, true);
  assert.equal(out.answered, true);
  assert.equal(out.edited, false);
  assert.equal(pauseCalls(client.calls, "editMessageText").length, 0);
});

test("API failure: state is still persisted even when answer/edit fail (non-throwing)", async () => {
  const client = makeFakeClient({ failAnswer: true, failEdit: true });
  const out = await handlePauseCallbackQuery(
    deps(client),
    makeCallbackUpdate(9, CALLBACK_PAUSE).callback_query,
  );

  assert.equal(
    out.ok,
    true,
    "never throws — failures are reported, not raised",
  );
  assert.equal(out.paused, true, "state persisted even when the answer fails");
  assert.equal(out.answered, false);
  assert.equal(out.edited, false);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).paused, true);
});

test("foreign sender shape is accepted at the handler level (the poller does the allow-list)", async () => {
  const client = makeFakeClient();
  const cq = makeCallbackUpdate(10, CALLBACK_STATUS, {
    fromId: 777000,
  }).callback_query;
  const out = await handlePauseCallbackQuery(deps(client), cq);
  assert.equal(out.action, CALLBACK_STATUS);
  assert.equal(out.answered, true);
});

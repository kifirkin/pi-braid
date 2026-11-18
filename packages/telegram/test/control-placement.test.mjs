/**
 * control-placement.test.mjs — the control keyboard is placed ONCE per chat,
 * not once per boot.
 *
 * The placement seam runs at every poller start, and a restart is a new
 * process, so "is the control already in this chat" cannot be a variable: it is
 * the record on disk beside the pause state (lib/state-paths.ts). These cases
 * drive placement through that record against a recording stub client:
 *
 *   leg 1  two boots, one root -> sendMessage once, editMessageText once, same
 *          chat, same message id (the second boot edits what the first posted)
 *   leg 2  the record is what does it: with no record file the same two boots
 *          post twice (removing the read reddens leg 1 — see the report)
 *   leg 3  a restart while paused edits the PAUSED body + ▶ Resume button
 *   leg 4  a not-found edit posts a replacement and rewrites the record; a
 *          transient edit failure posts nothing and keeps the recorded control
 *   leg 5  the seam itself: two extension factories in one process over one
 *          braid root (the reload/restart shape) place one control, the second
 *          boot editing the first boot's message
 *
 * NO network: every client is a recorder, every fetch a fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTROL_PAUSED_TEXT,
  CONTROL_RUNNING_TEXT,
  CALLBACK_RESUME,
  controlRecordFileFor,
  loadControlPlacementRecord,
  placeControlKeyboard,
  savePauseState,
  loadPauseState,
} from "../dist/lib/pause-control.js";
import telegramExtension from "../dist/index.js";
import {
  BOT_TOKEN,
  OWNER_CHAT_ID,
  getUpdatesResult,
  jsonResponse,
  makeFakeFetch,
  sendMessageResult,
} from "./fixtures.mjs";
import { sleep, waitFor } from "./helpers/poll.mjs";

/**
 * Strip the ambient inputs a direct run inherits (the runner's child-env.mjs
 * strips the same set for the children it spawns): this session's worker role
 * would refuse every poller start, and the live poll opt-in/out knobs would
 * pick the branch for the test. Leg 5 starts a real poller, so both matter.
 */
for (const key of [
  "BRAID_SESSION_ROLE",
  "BRAID_TG_POLL_ENABLED",
  "BRAID_TG_POLL_DISABLED",
  "TELEGRAM_POLL_ENABLED",
  "TELEGRAM_POLL_DISABLED",
  "TELEGRAM_POLLER_LOCK_FILE",
]) {
  delete process.env[key];
}

/** The call order of one leg, printed so the report can quote what ran. */
function describeCalls(calls) {
  return calls
    .map((c) =>
      c.method === "sendMessage"
        ? `sendMessage(chat=${c.chatId}, msg=${c.messageId ?? "?"})`
        : `editMessageText(chat=${c.chatId}, msg=${c.messageId})`,
    )
    .join(" -> ");
}

/**
 * One boot's view of the world: a fresh client recorder (nothing survives a
 * process boundary except the files under `root`) and the record path derived
 * exactly as index.ts derives it from the pause state.
 */
function boot(root, { editFails = null, nextMessageId = 600 } = {}) {
  const calls = [];
  const client = {
    async sendMessage(_token, chatId, text, opts) {
      calls.push({
        method: "sendMessage",
        chatId,
        text,
        opts,
        messageId: nextMessageId,
      });
      return { ok: true, messageId: nextMessageId };
    },
    async editMessageText(_token, chatId, messageId, text, opts) {
      calls.push({ method: "editMessageText", chatId, messageId, text, opts });
      if (editFails !== null) return { ok: false, error: editFails };
      return { ok: true, messageId };
    },
  };
  return {
    calls,
    client,
    /** Place with the reader a leg supplies; the record file is the production derivation. */
    async place(chatId, getPauseState, recordFile) {
      const res = await placeControlKeyboard(chatId, {
        client,
        token: BOT_TOKEN,
        getPauseState,
        recordFile:
          recordFile === undefined
            ? controlRecordFileFor(join(root, "telegram", "pause-state.json"))
            : recordFile,
      });
      return res;
    },
  };
}

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `tg-control-${prefix}-`));
}

function runningReader() {
  return async () => ({ paused: false, updatedAt: 0 });
}

// ── leg 1: two boots, one message ───────────────────────────────────────────

test("leg 1: two boots over one root -> one sendMessage, then one editMessageText of the SAME message", async () => {
  const root = tmpRoot("two-boots");
  const first = boot(root, { nextMessageId: 600 });
  const posted = await first.place(OWNER_CHAT_ID, runningReader());
  const recordAfterFirst = JSON.parse(
    readFileSync(
      controlRecordFileFor(join(root, "telegram", "pause-state.json")),
      "utf8",
    ),
  );

  // A restart is a new process: new client, new closure, same files.
  const second = boot(root, { nextMessageId: 601 });
  const edited = await second.place(OWNER_CHAT_ID, runningReader());

  console.log(
    `[leg 1] boot 1: ${describeCalls(first.calls)} | boot 2: ${describeCalls(second.calls)} | record=${JSON.stringify(recordAfterFirst)}`,
  );

  assert.equal(posted.via, "send", "no record -> the first boot posts");
  assert.equal(
    edited.via,
    "edit",
    "a record for this chat -> the next boot edits",
  );
  assert.equal(first.calls.length, 1, "boot 1 issued exactly one call");
  assert.equal(first.calls[0].method, "sendMessage");
  assert.equal(second.calls.length, 1, "boot 2 issued exactly one call");
  assert.equal(second.calls[0].method, "editMessageText");
  assert.equal(
    String(second.calls[0].chatId),
    String(OWNER_CHAT_ID),
    "same chat",
  );
  assert.equal(
    second.calls[0].messageId,
    600,
    "same message id the first boot's post returned",
  );
  assert.equal(
    callsOfMethod(first, second, "sendMessage"),
    1,
    "one sendMessage across both boots",
  );
  assert.equal(recordAfterFirst.messageId, 600);
  assert.equal(edited.messageId, 600);
});

function callsOfMethod(...args) {
  const [first, second] = args;
  return [...first.calls, ...second.calls].filter(
    (c) => c.method === "sendMessage",
  ).length;
}

// ── leg 2: the record is what makes the difference ──────────────────────────

test("leg 2: the same two boots with no record file post twice (the record is the only cross-boot state)", async () => {
  const root = tmpRoot("no-record");
  const first = boot(root, { nextMessageId: 700 });
  await first.place(OWNER_CHAT_ID, runningReader(), null);
  const second = boot(root, { nextMessageId: 701 });
  await second.place(OWNER_CHAT_ID, runningReader(), null);

  console.log(
    `[leg 2] boot 1: ${describeCalls(first.calls)} | boot 2: ${describeCalls(second.calls)}`,
  );

  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].method, "sendMessage");
  assert.equal(second.calls.length, 1);
  assert.equal(
    second.calls[0].method,
    "sendMessage",
    "no record -> the second boot cannot know the first message, so it posts",
  );
  assert.equal(
    await loadControlPlacementRecord(
      controlRecordFileFor(join(root, "telegram", "pause-state.json")),
    ),
    null,
    "no record file was written either",
  );
});

// ── leg 3: a restart while paused edits the paused body ─────────────────────

test("leg 3: restart while paused -> the edit carries the paused text and the ▶ Resume button", async () => {
  const root = tmpRoot("paused");
  const stateFile = join(root, "telegram", "pause-state.json");
  const recordFile = controlRecordFileFor(stateFile);
  const reader = async () => loadPauseState(stateFile);

  const first = boot(root, { nextMessageId: 800 });
  await first.place(OWNER_CHAT_ID, reader);

  // The owner taps Pause (the tap handler persists the flag), then the agent
  // restarts: the placement must refresh the SAME message to the paused body.
  mkdirSync(join(root, "telegram"), { recursive: true });
  await savePauseState(stateFile, { paused: true, updatedAt: 5 });
  const second = boot(root, { nextMessageId: 801 });
  const outcome = await second.place(OWNER_CHAT_ID, reader);

  console.log(
    `[leg 3] boot 1: ${describeCalls(first.calls)} | boot 2: ${describeCalls(second.calls)} | text=${JSON.stringify(second.calls[0].text)}`,
  );

  assert.equal(
    first.calls[0].text,
    CONTROL_RUNNING_TEXT,
    "boot 1: running body",
  );
  assert.equal(outcome.via, "edit");
  assert.equal(second.calls.length, 1);
  assert.equal(
    second.calls[0].text,
    CONTROL_PAUSED_TEXT,
    "the edit body reflects the persisted pause flag, not a default",
  );
  const primary = second.calls[0].opts.replyMarkup.inline_keyboard[0][0];
  assert.deepEqual(
    primary,
    { text: "▶ Resume", callback_data: CALLBACK_RESUME },
    "the primary button resumes (the action that changes the state)",
  );
  assert.equal(
    (await loadControlPlacementRecord(recordFile))?.messageId,
    800,
    "the record still names the message the first boot posted",
  );
});

// ── leg 4: a gone message, and a transient failure ──────────────────────────

test("leg 4: not-found edit -> post a replacement and rewrite the record; the third boot edits the new id", async () => {
  const root = tmpRoot("not-found");
  const reader = runningReader();
  const first = boot(root, { nextMessageId: 900 });
  await first.place(OWNER_CHAT_ID, reader);

  // The owner deleted the control: Telegram refuses the edit with not-found.
  const second = boot(root, {
    nextMessageId: 901,
    editFails: "Bad Request: message to edit not found",
  });
  const replaced = await second.place(OWNER_CHAT_ID, reader);
  const third = boot(root, { nextMessageId: 902 });
  const afterReplace = await third.place(OWNER_CHAT_ID, reader);

  console.log(
    `[leg 4] boot 1: ${describeCalls(first.calls)} | boot 2: ${describeCalls(second.calls)} | boot 3: ${describeCalls(third.calls)} | record=${JSON.stringify(readFileSync(controlRecordFileFor(join(root, "telegram", "pause-state.json")), "utf8").trim())}`,
  );

  assert.equal(replaced.via, "send", "a gone message earns a replacement");
  assert.deepEqual(
    second.calls.map((c) => c.method),
    ["editMessageText", "sendMessage"],
    "edit first, then the replacement post",
  );
  assert.equal(afterReplace.via, "edit");
  assert.equal(
    third.calls[0].messageId,
    901,
    "the record names the replacement, so the next boot edits THAT message",
  );
  assert.equal(
    [...first.calls, ...second.calls, ...third.calls].filter(
      (c) => c.method === "sendMessage",
    ).length,
    2,
    "two posts total: the first control and its one replacement",
  );
});

test("leg 4b: a transient edit failure posts NOTHING and keeps the recorded control", async () => {
  const root = tmpRoot("transient");
  const reader = runningReader();
  const first = boot(root, { nextMessageId: 950 });
  await first.place(OWNER_CHAT_ID, reader);
  const recordFile = controlRecordFileFor(
    join(root, "telegram", "pause-state.json"),
  );
  const before = readFileSync(recordFile, "utf8");

  const second = boot(root, {
    editFails: "Too Many Requests: retry after 3",
  });
  const outcome = await second.place(OWNER_CHAT_ID, reader);

  console.log(
    `[leg 4b] boot 1: ${describeCalls(first.calls)} | boot 2: ${describeCalls(second.calls)}`,
  );

  assert.equal(outcome.ok, false, "the failure is reported");
  assert.deepEqual(
    second.calls.map((c) => c.method),
    ["editMessageText"],
    "no rival control under the recorded one",
  );
  assert.equal(
    readFileSync(recordFile, "utf8"),
    before,
    "the record still names the control that is still in the chat",
  );
});

// ── leg 5: the seam — two factories, one control ────────────────────────────

/** Minimal pi surface the factory touches (same shape index.test.mjs drives). */
function makeFakePi() {
  const handlers = new Map();
  const messages = [];
  return {
    tools: [],
    handlers,
    messages,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendUserMessage: (...args) => messages.push(args),
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
}

test("leg 5: two factories over one braid root place ONE control — the second boot edits it", async () => {
  const root = tmpRoot("seam");
  const stateFile = join(root, "telegram-state.json");
  const calls = [];
  let nextId = 600;
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      const body = JSON.parse(init.body);
      calls.push({ method: "sendMessage", body });
      nextId += 1;
      return jsonResponse(sendMessageResult(nextId));
    }
    if (url.includes("editMessageText")) {
      const body = JSON.parse(init.body);
      calls.push({ method: "editMessageText", body });
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse(getUpdatesResult([]));
  });

  const env = {
    BRAID_TG_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_BOT_TOKEN: undefined,
    BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
    TELEGRAM_CHAT_ID: undefined,
    BRAID_TG_ALLOWED_USERS: undefined,
    BRAID_TG_POLL_ENABLED: "1",
    TELEGRAM_POLL_ENABLED: undefined,
    BRAID_TG_POLL_DISABLED: undefined,
    TELEGRAM_POLL_DISABLED: undefined,
    BRAID_SESSION_ROLE: undefined,
    BRAID_TG_LIVE_UPDATE_ENABLED: "0",
    TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    BRAID_TG_NOTIFY_ENABLED: undefined,
    TELEGRAM_NOTIFY_ENABLED: undefined,
    BRAID_HOME: root,
    BRAID_TG_STATE_FILE: stateFile,
    TELEGRAM_STATE_FILE: undefined,
  };
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  // A live poller keeps the event loop alive, so every exit path shuts down
  // whatever this case started: a failed assertion here must fail the file,
  // not hang it.
  const live = new Set();
  const bootOnce = async () => {
    const pi = makeFakePi();
    live.add(pi);
    await telegramExtension(pi, { fetch: fetchFn });
    return pi;
  };
  const shutdown = async (pi) => {
    if (!live.delete(pi)) return;
    pi.emit("session_shutdown");
    await sleep(150); // the poller releases the machine-wide lock on stop
  };

  try {
    // Boot 1: a fresh root holds no record, so the control is POSTED.
    const pi1 = await bootOnce();
    await waitFor(
      () => calls.filter((c) => c.method === "sendMessage").length === 1,
      3000,
    );
    await shutdown(pi1);

    // Boot 2: the reload/restart shape — a NEW factory, fresh closures, same
    // braid root. The record is the only thing that can carry the message id.
    const pi2 = await bootOnce();
    await waitFor(
      () => calls.filter((c) => c.method === "editMessageText").length === 1,
      3000,
    );
    await shutdown(pi2);

    console.log(
      `[leg 5] ${calls
        .map((c) =>
          c.method === "editMessageText"
            ? `editMessageText(msg=${c.body.message_id})`
            : `sendMessage(chat=${c.body.chat_id})`,
        )
        .join(
          " -> ",
        )} | record=${readFileSync(controlRecordFileFor(join(root, "telegram", "pause-state.json")), "utf8").trim()}`,
    );

    assert.equal(
      calls.filter((c) => c.method === "sendMessage").length,
      1,
      "one control message across two boots",
    );
    const edits = calls.filter((c) => c.method === "editMessageText");
    assert.equal(edits.length, 1, "the second boot edited instead of posting");
    assert.equal(
      String(edits[0].body.chat_id),
      String(OWNER_CHAT_ID),
      "the edit targets the owner chat",
    );
    assert.equal(
      edits[0].body.message_id,
      601,
      "the edit targets the message the first boot posted",
    );
  } finally {
    for (const pi of [...live]) await shutdown(pi);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

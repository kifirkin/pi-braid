/**
 * STT reliability — key pool failover, quiet-audio normalization,
 * honest failure line, counters. Recorded-fixture fake fetch, NO network.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSttKeyCandidates,
  getSttCounters,
  resetSttState,
  getPreferredSttKey,
  rememberSttKeyWinner,
} from "../dist/lib/stt-keys.js";
import {
  transcribeVoiceReliable,
  DEFAULT_STT_CHAT_MODEL,
} from "../dist/lib/transcribe.js";
import { buildFfmpegNormalizeArgs } from "../dist/lib/audio-normalize.js";
import { jsonResponse, makeFakeFetch } from "./fixtures.mjs";

const OGG_BYTES = new Uint8Array([79, 103, 103, 83, 0, 1, 2, 3]); // "OggS" prefix

function chatResponse(text) {
  return jsonResponse({ choices: [{ message: { content: text } }] });
}

const CANDS = [
  { key: "k1", source: "env", index: 0 },
  { key: "k2", source: "list", index: 1 },
];

test("candidate resolver: explicit > list > keyring > AGENT_ZERO_API_KEY* (stable order, dedupe)", async () => {
  const exec = async () => ({ stdout: "kr-key\n" });
  const cands = await resolveSttKeyCandidates({
    explicit: "exp-key",
    env: {
      BRAID_TG_STT_KEYS: "list-a, list-b\nlist-c",
      AGENT_ZERO_API_KEY: "v0",
      AGENT_ZERO_API_KEY_P0: "vP0",
      AGENT_ZERO_API_KEY_P1: "vP1",
      BRAID_TG_STT_API_KEY: "SHOULD_NOT_APPEAR",
    },
    exec,
    platform: "darwin",
  });
  assert.deepEqual(
    cands.map((c) => c.key),
    ["exp-key", "list-a", "list-b", "list-c", "kr-key", "v0", "vP0", "vP1"],
  );
  assert.deepEqual(
    cands.map((c) => c.source),
    ["explicit", "list", "list", "list", "keyring", "env", "env", "env"],
  );
  assert.deepEqual(
    cands.map((c) => c.index),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
});

test("candidate resolver: keyring tolerated-absent; skipped on non-darwin; dedupe by key value", async () => {
  const absentExec = async () => null;
  const cands = await resolveSttKeyCandidates({
    env: { AGENT_ZERO_API_KEY: "v0", BRAID_TG_STT_KEYS: "v0 k1" },
    exec: absentExec,
    platform: "darwin",
  });
  assert.deepEqual(
    cands.map((c) => c.key),
    ["v0", "k1"],
  );

  const darwinless = await resolveSttKeyCandidates({
    env: { AGENT_ZERO_API_KEY: "v0" },
    exec: async () => ({ stdout: "kr-key" }),
    platform: "linux",
  });
  assert.deepEqual(
    darwinless.map((c) => c.source),
    ["env"],
  );
});

test("failover: candidate 1 → 403 quota, candidate 2 → 200 (second key used, transcript returned)", async () => {
  resetSttState();
  let n = 0;
  const fetchFn = makeFakeFetch(async () => {
    n += 1;
    if (n === 1) {
      return jsonResponse(
        { error: { message: "User has no quota left" } },
        403,
      );
    }
    return chatResponse("привет");
  });
  const r = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: CANDS,
    fetchFn,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.text, "привет");
    assert.deepEqual(r.key, { index: 1, source: "list" });
  }
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(fetchFn.calls[0].headers.Authorization, "Bearer k1");
  assert.equal(fetchFn.calls[1].headers.Authorization, "Bearer k2");
  const counters = getSttCounters();
  assert.equal(counters.attempts, 2);
  assert.deepEqual(counters.successesByCandidateIndex, { 1: 1 });
});

test("all candidates exhausted → informative degrade line (host, attempts, class, hint, no key material)", async () => {
  resetSttState();
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ error: { message: "User has no quota left" } }, 403),
  );
  const r = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: CANDS,
    baseUrl: "https://llm.agent-zero.ai/v1",
    fetchFn,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.error.includes("llm.agent-zero.ai"));
    assert.ok(r.error.includes("2 request(s)"));
    assert.ok(/quota/i.test(r.error));
    assert.ok(/BRAID_TG_STT_KEYS/.test(r.error));
    assert.ok(!r.error.includes("k1") && !r.error.includes("k2"));
    assert.equal(r.lastClass, "quota");
  }
  const counters = getSttCounters();
  assert.ok(counters.failuresByClass.quota >= 1);
});

test("transport failure (no HTTP status) → one retry on the SAME key, note still transcribes", async () => {
  resetSttState();
  let n = 0;
  const fetchFn = makeFakeFetch(async () => {
    n += 1;
    if (n === 1) throw new Error("fetch failed"); // ECONNRESET/DNS-class, no HTTP status
    return chatResponse("привет");
  });
  const r = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: CANDS,
    baseUrl: "https://llm.agent-zero.ai/v1",
    transportRetryDelayMs: 0,
    fetchFn,
  });
  assert.equal(
    r.ok,
    true,
    `a transport hiccup must not lose the note: ${r.error}`,
  );
  if (r.ok) assert.equal(r.text, "привет");

  assert.equal(fetchFn.calls.length, 2, "one request + one retry");
  // A network failure says nothing about the key → the retry reuses it.
  assert.equal(fetchFn.calls[0].headers.Authorization, "Bearer k1");
  assert.equal(fetchFn.calls[1].headers.Authorization, "Bearer k1");

  const counters = getSttCounters();
  assert.equal(counters.transportRetries, 1);
  assert.equal(counters.transportRetrySuccesses, 1);
  assert.equal(counters.attempts, 1, "a retry is not a second candidate hit");
  assert.deepEqual(counters.successesByCandidateIndex, { 0: 1 });
});

test("a transport failure that survives the retry: honest line, distinct counters, pool NOT advanced", async () => {
  resetSttState();
  const fetchFn = makeFakeFetch(async () => {
    throw new Error("fetch failed");
  });
  const r = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: CANDS,
    baseUrl: "https://llm.agent-zero.ai/v1",
    transportRetryDelayMs: 0,
    normalize: { enabled: false },
    fetchFn,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.error.includes("llm.agent-zero.ai"), r.error);
    assert.ok(r.error.includes("1 round(s), 2 request(s)"), r.error);
    assert.ok(r.error.includes("(1 transport retry)"), r.error);
    assert.ok(r.error.includes("class other"), r.error);
    assert.ok(r.error.includes("key 0/env"), r.error);
    assert.equal(r.attempts, 1, "attempts stays the key-pool attempt count");
    assert.equal(r.retries, 1);
  }
  assert.equal(
    fetchFn.calls.length,
    2,
    "bounded: exactly one retry, not a loop",
  );
  assert.equal(fetchFn.calls[1].headers.Authorization, "Bearer k1");

  const counters = getSttCounters();
  assert.equal(counters.transportRetries, 1);
  assert.equal(counters.transportRetrySuccesses, 0);
  assert.equal(counters.attempts, 1, "the second candidate was never tried");
  assert.ok(counters.failuresByClass.other >= 1);
});

test("only a thrown request is retried: an HTTP status (class other) or a text-less 200 is not", async () => {
  // 5xx carries the class "other" too — the retry keys on the throw, not the class.
  resetSttState();
  const httpFn = makeFakeFetch(async () =>
    jsonResponse({ error: { message: "upstream unavailable" } }, 503),
  );
  const http = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: CANDS,
    transportRetryDelayMs: 0,
    normalize: { enabled: false },
    fetchFn: httpFn,
  });
  assert.equal(http.ok, false);
  assert.equal(httpFn.calls.length, 1, "an answered request is not retried");
  assert.equal(getSttCounters().transportRetries, 0);

  // A 200 with no transcript is a response, not a transport failure.
  resetSttState();
  const emptyFn = makeFakeFetch(async () =>
    jsonResponse({ choices: [{ message: {} }] }),
  );
  const empty = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: CANDS,
    transportRetryDelayMs: 0,
    normalize: { enabled: false },
    fetchFn: emptyFn,
  });
  assert.equal(empty.ok, false);
  assert.equal(emptyFn.calls.length, 1, "a text-less response is not retried");
  assert.equal(getSttCounters().transportRetries, 0);
});

test("transport retry delay default is seconds-scale (the retry waits, it does not hammer)", async () => {
  // Dynamic import: this constant is the sentinel for the bound itself, so the
  // file must still load and fail on BEHAVIOUR when the retry is absent.
  const mod = await import("../dist/lib/transcribe.js");
  assert.equal(mod.DEFAULT_STT_TRANSPORT_RETRY_DELAY_MS, 2000);
});

test("failover honors the remembered winner on the next call (process-lifetime memory)", async () => {
  resetSttState();
  rememberSttKeyWinner(CANDS[1]);
  const urls = [];
  const fetchFn = makeFakeFetch(async (url) => {
    urls.push(url);
    return chatResponse("ok");
  });
  const r = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: CANDS,
    fetchFn,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.key, { index: 1, source: "list" });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].headers.Authorization, "Bearer k2");
  assert.deepEqual(getPreferredSttKey()?.key, "k2");
});

test("keyring source behind injectable exec (present → candidate; absent → tolerated)", async () => {
  resetSttState();
  const present = await resolveSttKeyCandidates({
    env: {},
    exec: async () => ({ stdout: "kr-key\n" }),
    platform: "darwin",
  });
  assert.deepEqual(
    present.map((c) => ({ key: c.key, source: c.source })),
    [{ key: "kr-key", source: "keyring" }],
  );
  const absent = await resolveSttKeyCandidates({
    env: {},
    exec: async () => null,
    platform: "darwin",
  });
  assert.equal(absent.length, 0);
});

test("normalization arg builder: fixed gain, opus out, pipes in/out", () => {
  const args = buildFfmpegNormalizeArgs();
  const joined = args.join(" ");
  assert.ok(joined.includes("pipe:0"));
  assert.ok(joined.includes("volume=18dB"));
  assert.ok(joined.includes("pipe:1"));
  assert.ok(joined.includes("libopus"));
});

test("empty transcript → retry once with normalized bytes (two rounds, normalization applied)", async () => {
  resetSttState();
  let n = 0;
  const fetchFn = makeFakeFetch(async () => {
    n += 1;
    return n === 1 ? chatResponse("   ") : chatResponse("раз два");
  });
  const normalizeBytes = async (bytes) => new Uint8Array([...bytes, 0xff]); // fake ffmpeg: marker bytes appended
  const r = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: [{ key: "k1", source: "explicit", index: 0 }],
    fetchFn,
    normalize: { enabled: true, normalizeBytes },
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "раз два");
  assert.equal(fetchFn.calls.length, 2);
  // The second round must carry the NORMALIZED bytes, not the raw ones.
  const body1 = JSON.parse(fetchFn.calls[0].body);
  const body2 = JSON.parse(fetchFn.calls[1].body);
  const rawB64 = Buffer.from(OGG_BYTES).toString("base64");
  assert.equal(body1.messages[0].content[0].input_audio.data, rawB64);
  assert.equal(
    body2.messages[0].content[0].input_audio.data,
    Buffer.from([...OGG_BYTES, 0xff]).toString("base64"),
  );
  assert.equal(getSttCounters().normalizationsApplied, 1);
});

test("normalization disabled → single round even on empty transcript", async () => {
  resetSttState();
  const fetchFn = makeFakeFetch(async () => chatResponse("  "));
  let normalizeCalls = 0;
  const r = await transcribeVoiceReliable({
    bytes: OGG_BYTES,
    mode: "chat",
    keys: [{ key: "k1", source: "explicit", index: 0 }],
    fetchFn,
    normalize: {
      enabled: false,
      normalizeBytes: async () => {
        normalizeCalls += 1;
        return OGG_BYTES;
      },
    },
  });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(normalizeCalls, 0);
  // Honest outcome: empty transcript is reported as a failure, not a blank ok.
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(/empty transcript/i.test(r.error));
});

test("model default: chat mode defaults to gemini-3-8-flash (stable on quiet audio)", async () => {
  assert.equal(DEFAULT_STT_CHAT_MODEL, "gemini-3-8-flash");
});

/**
 * transcribe.test.mjs — STT adapter fixture tests for BOTH provider paths
 * (recorded-fetch fake, NO network):
 *
 *  - mode "chat" (Venice input_audio, the deployment default): POST
 *    {baseUrl}/chat/completions with the bytes as base64 `input_audio.data`
 *    (format "ogg"), transcript parsed from choices[0].message.content.
 *  - mode "transcriptions" (OpenAI-compatible): multipart form to
 *    /audio/transcriptions (file voice.ogg + model), text parsed from `text`.
 *
 * Plus the never-throws contract on both paths (non-ok / network failure /
 * missing key / malformed response).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  transcribeVoice,
  DEFAULT_STT_BASE_URL,
  DEFAULT_STT_MODEL,
  DEFAULT_STT_CHAT_BASE_URL,
  DEFAULT_STT_CHAT_MODEL,
} from "../dist/lib/transcribe.js";
import { jsonResponse, makeFakeFetch } from "./fixtures.mjs";

const OGG_BYTES = new Uint8Array([
  0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00,
]);
const OGG_B64 = Buffer.from(OGG_BYTES).toString("base64");

// ── chat mode (Venice input_audio) ──────────────────────────────────────────

test("chat mode: POSTs {baseUrl}/chat/completions with base64 input_audio (format ogg), parses choices[0].message.content", async () => {
  const calls = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "привет мир" } }],
    });
  });

  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "venice-key",
    mode: "chat",
    fetchFn,
  });

  assert.equal(r.ok, true);
  assert.equal(r.ok && r.text, "привет мир");

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${DEFAULT_STT_CHAT_BASE_URL}/chat/completions`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer venice-key");
  assert.equal(init.headers["Content-Type"], "application/json");

  const body = JSON.parse(init.body);
  assert.equal(
    body.model,
    DEFAULT_STT_CHAT_MODEL,
    "chat default model gemini-3-5-flash-lite",
  );
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  const content = body.messages[0].content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "input_audio");
  assert.equal(
    content[0].input_audio.data,
    OGG_B64,
    "input_audio.data is base64 of the bytes",
  );
  assert.equal(content[0].input_audio.format, "ogg");
  assert.equal(content[1].type, "text");
  assert.match(content[1].text, /Transcribe this voice message verbatim/);
});

test("chat mode: explicit baseUrl + model are honored (trailing slash stripped)", async () => {
  const calls = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  });

  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "k",
    mode: "chat",
    baseUrl: "https://custom.example/v1/",
    model: "custom-audio-model",
    fetchFn,
  });

  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://custom.example/v1/chat/completions");
  assert.equal(JSON.parse(calls[0].init.body).model, "custom-audio-model");
});

test("chat mode: non-ok response degrades to { ok:false, error } (never throws)", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ error: "invalid api key" }, 401),
  );
  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "k",
    mode: "chat",
    fetchFn,
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.ok || r.error.startsWith("HTTP 401"),
    `got: ${r.ok ? "" : r.error}`,
  );
});

test("chat mode: missing choices[0].message.content degrades to a clear error", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ choices: [{ message: {} }] }),
  );
  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "k",
    mode: "chat",
    fetchFn,
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.error.includes("missing text"));
});

test("chat mode: network failure degrades to { ok:false, error } (never throws)", async () => {
  const fetchFn = makeFakeFetch(async () => {
    throw new Error("ECONNRESET");
  });
  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "k",
    mode: "chat",
    transportRetryDelayMs: 0, // keep the suite off the real retry pause
    fetchFn,
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.error.includes("ECONNRESET"));
  // A thrown request carries no HTTP status → exactly one retry, same key.
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(fetchFn.calls[1].headers.Authorization, "Bearer k");
  assert.equal(r.ok || r.retries, 1);
});

test("chat mode: configured language is threaded into the prompt (BRAID_TG_STT_LANGUAGE honored); defaults to Russian when absent", async () => {
  const calls = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  });

  // Explicit language wins.
  const r1 = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "venice-key",
    mode: "chat",
    language: "Spanish",
    fetchFn,
  });
  assert.equal(r1.ok, true);
  let content = JSON.parse(calls[0].init.body).messages[0].content;
  assert.match(
    content[1].text,
    /\(Spanish\)/,
    "configured language must appear in the chat prompt",
  );
  assert.ok(
    !/\(Russian\)/.test(content[1].text),
    "an explicit language must replace the default",
  );

  // No language → the deployment default (Russian) keeps the legacy prompt.
  const r2 = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "venice-key",
    mode: "chat",
    fetchFn,
  });
  assert.equal(r2.ok, true);
  content = JSON.parse(calls[1].init.body).messages[0].content;
  assert.match(
    content[1].text,
    /\(Russian\)/,
    "absent language must fall back to the Russian default",
  );
});

// ── transcriptions mode (OpenAI-compatible, kept intact) ───────────────────

test("transcriptions mode: multipart form to /audio/transcriptions (file voice.ogg + model), parses text", async () => {
  const calls = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ text: "hello" });
  });

  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "sk-test",
    mode: "transcriptions",
    fetchFn,
  });

  assert.equal(r.ok, true);
  assert.equal(r.ok && r.text, "hello");

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${DEFAULT_STT_BASE_URL}/audio/transcriptions`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer sk-test");
  const form = init.body;
  assert.ok(form instanceof FormData, "multipart form body");
  assert.equal(
    form.get("model"),
    DEFAULT_STT_MODEL,
    "transcriptions default model whisper-1",
  );
  const filePart = form.get("file");
  assert.ok(filePart instanceof File, "file part present");
  assert.equal(filePart.name, "voice.ogg");
});

test("transcriptions mode: language hint is appended to the form", async () => {
  const calls = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ text: "hi" });
  });
  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "sk-test",
    mode: "transcriptions",
    language: "en",
    fetchFn,
  });
  assert.equal(r.ok, true);
  const form = calls[0].init.body;
  assert.equal(form.get("language"), "en");
});

test("transcriptions mode: non-ok response degrades to { ok:false, error } (never throws)", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ error: "bad" }, 500),
  );
  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "k",
    mode: "transcriptions",
    fetchFn,
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.error.startsWith("HTTP 500"));
});

// ── shared contract ────────────────────────────────────────────────────────

test("both modes: no api key returns an error WITHOUT any request", async () => {
  let called = false;
  const fetchFn = makeFakeFetch(async () => {
    called = true;
    return jsonResponse({ text: "x" });
  });
  const r1 = await transcribeVoice({ bytes: OGG_BYTES, mode: "chat", fetchFn });
  assert.equal(r1.ok, false);
  assert.ok(r1.ok || r1.error.includes("no STT api key"));
  const r2 = await transcribeVoice({
    bytes: OGG_BYTES,
    mode: "transcriptions",
    fetchFn,
  });
  assert.equal(r2.ok, false);
  assert.equal(called, false, "no request without a key");
});

test("mode omitted defaults to transcriptions (backward compatible)", async () => {
  const calls = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ text: "legacy" });
  });
  const r = await transcribeVoice({
    bytes: OGG_BYTES,
    apiKey: "sk-test",
    fetchFn,
  });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, `${DEFAULT_STT_BASE_URL}/audio/transcriptions`);
});

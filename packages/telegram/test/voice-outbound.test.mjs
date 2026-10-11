/**
 * voice-outbound.test.mjs — outbound voice notes. Covers the
 * `braid.telegram.tts` reader, script→voice selection, the
 * edge-tts → ffmpeg ogg/opus pipeline, retry on intermittent failure, the
 * gated macOS `say` fallback, refusal when synthesis is disabled, and the
 * handoff of synthesized bytes into the existing telegram_send voice path.
 * The process seam is an injected runCommand mock: NO real spawn, NO
 * network, NO real Telegram send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TTS_ATTEMPTS,
  DEFAULT_TTS_RATE,
  DEFAULT_VOICE_TTS,
  buildEdgeTtsArgs,
  buildOggOpusArgs,
  buildSayArgs,
  defaultRunCommand,
  pickVoice,
  populateVoiceTts,
  readVoiceTtsConfig,
} from "../dist/lib/tts.js";
import { runTelegramSend } from "../dist/lib/tool-logic.js";

const BOT_TOKEN = "123:TEST-TOKEN";
const OWNER_CHAT_ID = 999888777;

/** Write a settings file under a fresh temp dir; return its path. */
function makeSettingsFile(raw) {
  const dir = mkdtempSync(join(tmpdir(), "tg-tts-settings-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(raw), "utf8");
  return file;
}

/** Settings path holding the given `braid.telegram.tts` block. */
function settingsWithTts(tts) {
  return makeSettingsFile({ braid: { telegram: { tts } } });
}

/**
 * Injected runCommand mock. Simulates uvx edge-tts (fails `failEdgeTimes`
 * attempts), macOS say (fails when `failSay`), and ffmpeg (writes empty
 * output when `emptyOgg`). Output files are written to the paths the real
 * commands receive, so the production code's reads exercise the same flow.
 */
function makeRunCommand({
  failEdgeTimes = 0,
  failSay = false,
  emptyOgg = false,
} = {}) {
  const calls = [];
  let edgeFailuresLeft = failEdgeTimes;
  const run = async (command, args) => {
    const call = { command, args };
    calls.push(call);
    if (command === "uvx") {
      if (edgeFailuresLeft > 0) {
        edgeFailuresLeft--;
        return { code: 1, stderr: "NoAudioReceived: no audio was received" };
      }
      const textFile = args[args.indexOf("--file") + 1];
      call.textContent = readFileSync(textFile, "utf8");
      writeFileSync(
        args[args.indexOf("--write-media") + 1],
        Buffer.from("MP3"),
      );
      return { code: 0, stderr: "" };
    }
    if (command === "say") {
      if (failSay) return { code: 1, stderr: "say: voice not found" };
      writeFileSync(args[args.indexOf("-o") + 1], Buffer.from("AIFF"));
      return { code: 0, stderr: "" };
    }
    if (command === "ffmpeg") {
      call.input = args[args.indexOf("-i") + 1];
      const output = args[args.length - 1];
      writeFileSync(
        output,
        emptyOgg ? Buffer.alloc(0) : Buffer.from(`OGG:${call.input}`),
      );
      return { code: 0, stderr: "" };
    }
    return { code: 127, stderr: `unexpected command: ${command}` };
  };
  return { run, calls };
}

/** Recording client for the existing send path. */
function makeRecordingClient() {
  const calls = { voice: [], text: [] };
  return {
    calls,
    client: {
      sendMessage: async (token, chatId, text, options = {}) => {
        calls.text.push({ token, chatId, text, options });
        return { ok: true, messageId: 1 };
      },
      sendVoiceNote: async (token, chatId, ogg, caption, options = {}) => {
        calls.voice.push({ token, chatId, ogg, caption, options });
        return { ok: true, messageId: 77 };
      },
    },
  };
}

// ── settings reader ─────────────────────────────────────────────────────────

test("readVoiceTtsConfig: missing file and absent block both mean edge-tts defaults", () => {
  const missing = join(tmpdir(), "tg-tts-does-not-exist", "settings.json");
  assert.deepEqual(readVoiceTtsConfig(missing), DEFAULT_VOICE_TTS);
  const absentBlock = makeSettingsFile({ braid: { telegram: {} } });
  assert.deepEqual(readVoiceTtsConfig(absentBlock), DEFAULT_VOICE_TTS);
});

test("readVoiceTtsConfig: valid overrides apply; invalid entries fall back; source none is kept", () => {
  const file = settingsWithTts({
    source: "edge-tts+say",
    rate: "-10%",
    voices: { ru: "ru-RU-SvetlanaNeural", en: "", he: 42 },
  });
  assert.deepEqual(readVoiceTtsConfig(file), {
    source: "edge-tts+say",
    rate: "-10%",
    voices: {
      ru: "ru-RU-SvetlanaNeural",
      en: DEFAULT_VOICE_TTS.voices.en, // empty string → default
      he: DEFAULT_VOICE_TTS.voices.he, // non-string → default
    },
  });
  assert.equal(
    readVoiceTtsConfig(settingsWithTts({ source: "none" })).source,
    "none",
  );
  assert.equal(
    readVoiceTtsConfig(settingsWithTts({ source: "nope" })).source,
    "edge-tts",
    "an unknown source falls back to the default, like every other entry",
  );
  assert.equal(
    readVoiceTtsConfig(settingsWithTts({ rate: "fast" })).rate,
    DEFAULT_TTS_RATE,
  );
});

test("populateVoiceTts: source none yields no hook (refusal path stays intact)", () => {
  const noneSettings = settingsWithTts({ source: "none" });
  assert.equal(populateVoiceTts({ settingsPath: noneSettings }), undefined);
});

// ── script → voice selection ────────────────────────────────────────────────

test("pickVoice: Cyrillic → ru, Hebrew → he, anything else → en", () => {
  const voices = { ru: "RU", en: "EN", he: "HE" };
  assert.equal(pickVoice("Привет, это голосовой ответ", voices), "RU");
  assert.equal(pickVoice("שלום, זו תשובה קולית", voices), "HE");
  assert.equal(pickVoice("Hello, this is a voice reply", voices), "EN");
});

// ── argv builders ───────────────────────────────────────────────────────────

test("argv builders: edge-tts, say, and the ogg/opus ffmpeg conversion", () => {
  assert.deepEqual(
    buildEdgeTtsArgs({
      voice: "ru-RU-DmitryNeural",
      rate: "+20%",
      textFile: "/t/in.txt",
      mediaFile: "/t/out.mp3",
    }),
    [
      "edge-tts",
      "-v",
      "ru-RU-DmitryNeural",
      "--rate=+20%",
      "--file",
      "/t/in.txt",
      "--write-media",
      "/t/out.mp3",
    ],
  );
  assert.deepEqual(
    buildSayArgs({
      voice: "Milena",
      textFile: "/t/in.txt",
      outFile: "/t/out.aiff",
    }),
    ["-v", "Milena", "-f", "/t/in.txt", "-o", "/t/out.aiff"],
  );
  assert.deepEqual(buildOggOpusArgs("/t/in.mp3", "/t/out.ogg"), [
    "-y",
    "-v",
    "error",
    "-i",
    "/t/in.mp3",
    "-c:a",
    "libopus",
    "-b:a",
    "48k",
    "-ar",
    "48000",
    "-ac",
    "1",
    "/t/out.ogg",
  ]);
});

// ── synthesize pipeline ─────────────────────────────────────────────────────

test("synthesize: Cyrillic text runs edge-tts with Dmitry at the default rate and returns OGG bytes", async () => {
  const { run, calls } = makeRunCommand();
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({}),
    runCommand: run,
  });
  const ogg = await tts.synthesize("Привет, владелец");
  assert.ok(ogg.byteLength > 0);
  assert.ok(ogg.toString().startsWith("OGG:"));

  const uvx = calls.filter((c) => c.command === "uvx");
  assert.equal(uvx.length, 1);
  assert.equal(
    uvx[0].args[uvx[0].args.indexOf("-v") + 1],
    "ru-RU-DmitryNeural",
  );
  assert.ok(uvx[0].args.includes(`--rate=${DEFAULT_TTS_RATE}`));
  assert.equal(uvx[0].textContent, "Привет, владелец", "text goes via --file");

  const ffmpeg = calls.filter((c) => c.command === "ffmpeg");
  assert.equal(ffmpeg.length, 1);
  assert.ok(ffmpeg[0].args.includes("libopus"));
  assert.ok(ffmpeg[0].args.includes("48k"));
});

test("synthesize: Hebrew and English texts pick their configured voices", async () => {
  for (const [text, voice] of [
    ["שלום", "he-IL-AvriNeural"],
    ["Hello there", "en-US-GuyNeural"],
  ]) {
    const { run, calls } = makeRunCommand();
    const tts = populateVoiceTts({
      settingsPath: settingsWithTts({}),
      runCommand: run,
    });
    await tts.synthesize(text);
    const uvx = calls.find((c) => c.command === "uvx");
    assert.equal(
      uvx.args[uvx.args.indexOf("-v") + 1],
      voice,
      `voice for ${text}`,
    );
  }
});

test("synthesize: settings rate and voice overrides reach the edge-tts argv", async () => {
  const { run, calls } = makeRunCommand();
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({
      rate: "-15%",
      voices: { ru: "ru-RU-SvetlanaNeural" },
    }),
    runCommand: run,
  });
  await tts.synthesize("Тест");
  const uvx = calls.find((c) => c.command === "uvx");
  assert.equal(uvx.args[uvx.args.indexOf("-v") + 1], "ru-RU-SvetlanaNeural");
  assert.ok(uvx.args.includes("--rate=-15%"));
});

test("synthesize: intermittent NoAudioReceived is retried, third attempt succeeds", async () => {
  const { run, calls } = makeRunCommand({ failEdgeTimes: 2 });
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({}),
    runCommand: run,
  });
  const ogg = await tts.synthesize("Retry me");
  assert.ok(ogg.byteLength > 0);
  assert.equal(
    calls.filter((c) => c.command === "uvx").length,
    DEFAULT_TTS_ATTEMPTS,
  );
});

test("synthesize: edge-tts failure after all attempts rejects with the voice error; no say fallback", async () => {
  const { run, calls } = makeRunCommand({
    failEdgeTimes: DEFAULT_TTS_ATTEMPTS,
  });
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({ source: "edge-tts" }),
    runCommand: run,
  });
  await assert.rejects(
    () => tts.synthesize("Will fail"),
    /edge-tts failed after 3 attempts.*NoAudioReceived/,
  );
  assert.equal(
    calls.filter((c) => c.command === "uvx").length,
    DEFAULT_TTS_ATTEMPTS,
  );
  assert.equal(calls.filter((c) => c.command === "say").length, 0);
});

test("synthesize: empty ffmpeg output counts as a failed attempt and retries", async () => {
  const { run, calls } = makeRunCommand({ emptyOgg: true });
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({}),
    runCommand: run,
  });
  await assert.rejects(
    () => tts.synthesize("Empty output"),
    /edge-tts failed after 3 attempts.*empty output/,
  );
  assert.equal(
    calls.filter((c) => c.command === "uvx").length,
    DEFAULT_TTS_ATTEMPTS,
  );
  assert.equal(
    calls.filter((c) => c.command === "ffmpeg").length,
    DEFAULT_TTS_ATTEMPTS,
  );
});

// ── say fallback gating ─────────────────────────────────────────────────────

test("synthesize: edge-tts+say falls back to macOS say after the edge attempts are exhausted", async () => {
  const { run, calls } = makeRunCommand({
    failEdgeTimes: DEFAULT_TTS_ATTEMPTS,
  });
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({ source: "edge-tts+say" }),
    runCommand: run,
  });
  const ogg = await tts.synthesize("Fallback");
  assert.ok(ogg.byteLength > 0);
  assert.equal(
    calls.filter((c) => c.command === "uvx").length,
    DEFAULT_TTS_ATTEMPTS,
  );
  const say = calls.find((c) => c.command === "say");
  assert.deepEqual(say.args.slice(0, 2), ["-v", "Milena"]);
  const ffmpeg = calls.find((c) => c.command === "ffmpeg");
  assert.ok(
    ffmpeg.input.endsWith("say.aiff"),
    "the say output is what ffmpeg converts",
  );
});

test("synthesize: source say skips edge-tts entirely", async () => {
  const { run, calls } = makeRunCommand();
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({ source: "say" }),
    runCommand: run,
  });
  await tts.synthesize("Say only");
  assert.equal(calls.filter((c) => c.command === "uvx").length, 0);
  assert.equal(calls.filter((c) => c.command === "say").length, 1);
});

test("synthesize: edge-tts+say with both paths failing names both failures", async () => {
  const { run } = makeRunCommand({
    failEdgeTimes: DEFAULT_TTS_ATTEMPTS,
    failSay: true,
  });
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({ source: "edge-tts+say" }),
    runCommand: run,
  });
  await assert.rejects(
    () => tts.synthesize("Both fail"),
    /edge-tts failed after 3 attempts.*say fallback failed.*voice not found/,
  );
});

// ── handoff into the existing send path ─────────────────────────────────────

test("runTelegramSend: synthesized bytes flow into sendVoiceNote unchanged", async () => {
  const { run } = makeRunCommand();
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({}),
    runCommand: run,
  });
  const rc = makeRecordingClient();
  const outcome = await runTelegramSend(
    { text: "summary", voice: true, voiceText: "Привет" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, tts },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.channel, "voice");
  assert.equal(rc.calls.voice.length, 1);
  const sent = rc.calls.voice[0];
  assert.equal(sent.token, BOT_TOKEN);
  assert.equal(sent.chatId, OWNER_CHAT_ID);
  assert.equal(sent.caption, "summary");
  assert.ok(Buffer.isBuffer(sent.ogg));
  assert.ok(sent.ogg.byteLength > 0);
  assert.ok(sent.ogg.toString().startsWith("OGG:"));
  assert.equal(rc.calls.text.length, 0);
});

test("runTelegramSend: a synthesis throw becomes a voice error outcome, not a text send", async () => {
  const rc = makeRecordingClient();
  const outcome = await runTelegramSend(
    { text: "summary", voice: true },
    {
      client: rc.client,
      token: BOT_TOKEN,
      chatId: OWNER_CHAT_ID,
      tts: {
        synthesize: async () => {
          throw new Error("TTS: edge-tts failed after 3 attempts (boom)");
        },
      },
    },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.channel, "voice");
  assert.match(outcome.error, /voice synthesis failed.*edge-tts failed/);
  assert.equal(rc.calls.voice.length, 0);
  assert.equal(rc.calls.text.length, 0, "no silent text fallback");
});

test("runTelegramSend: disabled synthesis refuses voice with the configured-source error", async () => {
  const rc = makeRecordingClient();
  const outcome = await runTelegramSend(
    { text: "summary", voice: true },
    {
      client: rc.client,
      token: BOT_TOKEN,
      chatId: OWNER_CHAT_ID,
      tts: populateVoiceTts({
        settingsPath: settingsWithTts({ source: "none" }),
      }),
    },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /no TTS source is configured/);
  assert.equal(rc.calls.voice.length, 0);
  assert.equal(rc.calls.text.length, 0);
});

// ── temp-dir hygiene sanity ─────────────────────────────────────────────────

test("synthesize: the text file exists when edge-tts runs, and temp dirs are removed", async () => {
  const { run, calls } = makeRunCommand();
  const tts = populateVoiceTts({
    settingsPath: settingsWithTts({}),
    runCommand: run,
  });
  await tts.synthesize("Temp check");
  const uvx = calls.find((c) => c.command === "uvx");
  const textFile = uvx.args[uvx.args.indexOf("--file") + 1];
  assert.equal(
    existsSync(textFile),
    false,
    "temp dir is cleaned up in finally",
  );
});

// ── default process seam (the only path that really spawns) ────────────────

test("defaultRunCommand: a missing binary maps to code null with the spawn error", async () => {
  const result = await defaultRunCommand("braid-test-no-such-binary", []);
  assert.equal(result.code, null);
  assert.match(result.stderr, /ENOENT/);
});

test("defaultRunCommand: a hanging command is killed and reported as a timeout", async () => {
  const result = await defaultRunCommand(
    "node",
    ["-e", "setTimeout(() => {}, 60_000)"],
    { timeoutMs: 150 },
  );
  assert.equal(result.code, 124);
  assert.match(result.stderr, /killed after 150ms/);
});

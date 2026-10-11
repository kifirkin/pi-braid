/**
 * tts.ts — outbound text-to-speech for `telegram_send voice: true`.
 *
 * The Telegram voice path (tool-logic.ts) calls
 * `VoiceTtsHook.synthesize(text)` and expects OGG/Opus bytes for sendVoice.
 * This module is the single place a TTS source is wired in: it resolves the
 * `braid.telegram.tts` block in `~/.pi/agent/settings.json` (same reader
 * pattern as telegram-settings.ts: never throws, invalid entries fall back to
 * the defaults) and returns either a hook or `undefined` when synthesis is
 * disabled (`source: "none"`) — the refusal path in tool-logic.ts then keeps
 * returning its clear "no TTS source is configured" error, never text.
 *
 * Config shape (all keys optional; an absent block means edge-tts defaults):
 *   { "source": "edge-tts" | "edge-tts+say" | "say" | "none",
 *     "rate": "+20%",
 *     "voices": { "ru": "ru-RU-DmitryNeural",
 *                 "en": "en-US-GuyNeural",
 *                 "he": "he-IL-AvriNeural" } }
 *
 * Sources:
 *   edge-tts      — Microsoft edge-tts via uvx, the primary path (default).
 *   edge-tts+say  — edge-tts, falling back to macOS `say` only after the
 *                   edge attempts are exhausted (emergency: its quality is a
 *                   known compromise, so it stays behind this explicit
 *                   choice — better than losing the note to a flaky run).
 *   say           — macOS `say` only, for a machine without uv.
 *   none          — synthesis disabled; voice:true is refused, never text.
 *
 * Pipeline (matches the voice-replies skill):
 *   edge-tts: `uvx edge-tts -v <voice> --rate=<rate> --file <txt>
 *              --write-media <mp3>`
 *   say:      `say -v <sayVoice> -f <txt> -o <aiff>`
 *   both:     `ffmpeg -y -v error -i <in> -c:a libopus -b:a 48k -ar 48000
 *              -ac 1 <ogg>`
 *
 * edge-tts `NoAudioReceived` is intermittent (fail, ok, fail, ok-on-retry),
 * so the primary path retries up to DEFAULT_TTS_ATTEMPTS times before giving
 * up. Voice selection follows the text's script: Cyrillic → ru, Hebrew → he,
 * otherwise en. edge-tts must be version ≥ 7 via uvx (older pins such as
 * 6.1.12 die with WSServerHandshakeError 403), so the command pins nothing.
 *
 * Synthesis runs in a fresh temp dir cleaned up in a finally. Every spawn
 * goes through the injectable `RunCommand` seam: tests substitute a mock, the
 * default wraps node:child_process.spawn (argv arrays only — no shell).
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceTtsHook } from "./tool-logic.js";

/** pi-native settings file (same path telegram-settings.ts reads). */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Default voice-note rate: +20%. */
export const DEFAULT_TTS_RATE = "+20%";

/** edge-tts `NoAudioReceived` is intermittent; retry the primary path twice. */
export const DEFAULT_TTS_ATTEMPTS = 3;

/** macOS `say` voice for the emergency fallback (ru-female). */
export const DEFAULT_SAY_VOICE = "Milena";

/** Per-command timeouts: uvx may fetch edge-tts on first run. */
const EDGE_TTS_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const SAY_TIMEOUT_MS = 30_000;

export type VoiceTtsSource = "edge-tts" | "edge-tts+say" | "say" | "none";

export interface VoiceTtsVoices {
  ru: string;
  en: string;
  he: string;
}

export interface VoiceTtsConfig {
  source: VoiceTtsSource;
  rate: string;
  voices: VoiceTtsVoices;
}

/** Defaults for the absent block: edge-tts, rate +20%, the default voices. */
export const DEFAULT_VOICE_TTS: VoiceTtsConfig = {
  source: "edge-tts",
  rate: DEFAULT_TTS_RATE,
  voices: {
    ru: "ru-RU-DmitryNeural",
    en: "en-US-GuyNeural",
    he: "he-IL-AvriNeural",
  },
};

interface RawBraidSettings {
  braid?: {
    telegram?: {
      tts?: {
        source?: unknown;
        rate?: unknown;
        voices?: {
          ru?: unknown;
          en?: unknown;
          he?: unknown;
        };
      };
    };
  };
}

/** A known source string passes through; anything else → the default. */
function sanitizeSource(raw: unknown): VoiceTtsSource {
  switch (raw) {
    case "none":
      return "none";
    case "say":
      return "say";
    case "edge-tts+say":
      return "edge-tts+say";
    default:
      return "edge-tts";
  }
}

/** edge-tts rate syntax: a sign and 1-3 digits, e.g. "+20%". */
const RATE_PATTERN = /^[+-]\d{1,3}%$/;

function sanitizeRate(raw: unknown): string {
  return typeof raw === "string" && RATE_PATTERN.test(raw.trim())
    ? raw.trim()
    : DEFAULT_TTS_RATE;
}

function sanitizeVoice(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

/**
 * Resolve the TTS config from `settingsPath` (default
 * `~/.pi/agent/settings.json`). Never throws: a missing file, unreadable
 * JSON, or an invalid entry falls back to the default for that field.
 */
export function readVoiceTtsConfig(
  settingsPath: string = SETTINGS_PATH,
): VoiceTtsConfig {
  let parsed: RawBraidSettings | undefined;
  try {
    if (existsSync(settingsPath)) {
      parsed = JSON.parse(
        readFileSync(settingsPath, "utf8"),
      ) as RawBraidSettings;
    }
  } catch {
    // non-fatal — fall through to the defaults
  }
  const raw = parsed?.braid?.telegram?.tts;
  return {
    source: sanitizeSource(raw?.source),
    rate: sanitizeRate(raw?.rate),
    voices: {
      ru: sanitizeVoice(raw?.voices?.ru, DEFAULT_VOICE_TTS.voices.ru),
      en: sanitizeVoice(raw?.voices?.en, DEFAULT_VOICE_TTS.voices.en),
      he: sanitizeVoice(raw?.voices?.he, DEFAULT_VOICE_TTS.voices.he),
    },
  };
}

/** Result of one external command; never rejects, ENOENT/failure is `code: null`. */
export interface CommandResult {
  code: number | null;
  stderr: string;
}

/** Injected process seam: spawn one command and capture its exit + stderr. */
export type RunCommand = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<CommandResult>;

/** Default process seam: spawn (argv only, no shell), kill on timeout, never rejects. */
export const defaultRunCommand: RunCommand = async (
  command,
  args,
  opts = {},
) => {
  const { spawn } = await import("node:child_process");
  return await new Promise<CommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        code: null,
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.resume(); // drain — only the exit code and stderr are used
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => settle({ code: null, stderr: error.message }));
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle({
        // 124 is the timeout convention — a killed command is not a spawn failure.
        code: timedOut ? 124 : code,
        stderr:
          timedOut && !stderr.trim()
            ? `killed after ${opts.timeoutMs}ms`
            : stderr,
      });
    });
  });
};

const CYRILLIC_PATTERN = /[\u0400-\u04FF]/;
const HEBREW_PATTERN = /[\u0590-\u05FF]/;

/** Script-driven voice choice: Cyrillic → ru, Hebrew → he, otherwise en. */
export function pickVoice(text: string, voices: VoiceTtsVoices): string {
  if (CYRILLIC_PATTERN.test(text)) return voices.ru;
  if (HEBREW_PATTERN.test(text)) return voices.he;
  return voices.en;
}

/** edge-tts argv for one synthesis attempt. */
export function buildEdgeTtsArgs(opts: {
  voice: string;
  rate: string;
  textFile: string;
  mediaFile: string;
}): string[] {
  return [
    "edge-tts",
    "-v",
    opts.voice,
    `--rate=${opts.rate}`,
    "--file",
    opts.textFile,
    "--write-media",
    opts.mediaFile,
  ];
}

/** macOS `say` argv: read the text file, write an AIFF for ffmpeg. */
export function buildSayArgs(opts: {
  voice: string;
  textFile: string;
  outFile: string;
}): string[] {
  return ["-v", opts.voice, "-f", opts.textFile, "-o", opts.outFile];
}

/** ffmpeg argv: any input → OGG/Opus at 48 kHz mono (Telegram sendVoice). */
export function buildOggOpusArgs(
  inputFile: string,
  outputFile: string,
): string[] {
  return [
    "-y",
    "-v",
    "error",
    "-i",
    inputFile,
    "-c:a",
    "libopus",
    "-b:a",
    "48k",
    "-ar",
    "48000",
    "-ac",
    "1",
    outputFile,
  ];
}

/** Last line of stderr (or its tail) for a one-line attempt error. */
function describeFailure(source: string, result: CommandResult): string {
  const detail = result.stderr.trim().split("\n").filter(Boolean).pop() ?? "";
  const status =
    result.code === null ? "failed to spawn" : `exit ${result.code}`;
  return detail
    ? `${source} ${status}: ${detail.slice(0, 200)}`
    : `${source} ${status}`;
}

/** Run ffmpeg on `inputFile`; return non-empty OGG/Opus bytes or an error. */
async function convertToOggOpus(
  run: RunCommand,
  inputFile: string,
  outputFile: string,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const result = await run("ffmpeg", buildOggOpusArgs(inputFile, outputFile), {
    timeoutMs: FFMPEG_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return { ok: false, error: describeFailure("ffmpeg", result) };
  }
  try {
    const bytes = await readFile(outputFile);
    if (bytes.byteLength === 0) {
      return { ok: false, error: "ffmpeg produced empty output" };
    }
    return { ok: true, bytes };
  } catch (error) {
    return {
      ok: false,
      error: `ffmpeg output unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** One edge-tts attempt: synthesize to mp3, convert to ogg/opus. */
async function attemptEdgeTts(
  run: RunCommand,
  config: VoiceTtsConfig,
  voice: string,
  textFile: string,
  dir: string,
  attempt: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const mediaFile = join(dir, `edge-${attempt}.mp3`);
  const oggFile = join(dir, `edge-${attempt}.ogg`);
  const synth = await run(
    "uvx",
    buildEdgeTtsArgs({ voice, rate: config.rate, textFile, mediaFile }),
    { timeoutMs: EDGE_TTS_TIMEOUT_MS },
  );
  if (synth.code !== 0) {
    return { ok: false, error: describeFailure("edge-tts", synth) };
  }
  return await convertToOggOpus(run, mediaFile, oggFile);
}

/** macOS say: synthesize to AIFF, convert to ogg/opus. */
async function synthesizeWithSay(
  run: RunCommand,
  textFile: string,
  dir: string,
): Promise<Buffer> {
  const aiffFile = join(dir, "say.aiff");
  const oggFile = join(dir, "say.ogg");
  const synth = await run(
    "say",
    buildSayArgs({
      voice: DEFAULT_SAY_VOICE,
      textFile,
      outFile: aiffFile,
    }),
    { timeoutMs: SAY_TIMEOUT_MS },
  );
  if (synth.code !== 0) {
    throw new Error(describeFailure("say", synth));
  }
  const converted = await convertToOggOpus(run, aiffFile, oggFile);
  if (!converted.ok) throw new Error(converted.error);
  return converted.bytes;
}

/**
 * Synthesize `text` with the configured source. Never falls back to text:
 * on total failure this rejects with a voice-specific error, which
 * tool-logic.ts surfaces as a failed voice outcome.
 */
async function synthesizeVoice(
  text: string,
  config: VoiceTtsConfig,
  run: RunCommand,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "braid-tts-"));
  try {
    const textFile = join(dir, "speech.txt");
    await writeFile(textFile, text, "utf8");
    const voice = pickVoice(text, config.voices);

    let edgeError = "not attempted";
    if (config.source !== "say") {
      for (let attempt = 1; attempt <= DEFAULT_TTS_ATTEMPTS; attempt++) {
        const result = await attemptEdgeTts(
          run,
          config,
          voice,
          textFile,
          dir,
          attempt,
        );
        if (result.ok) return result.bytes;
        edgeError = result.error;
      }
      if (config.source === "edge-tts") {
        throw new Error(
          `TTS: edge-tts failed after ${DEFAULT_TTS_ATTEMPTS} attempts (${edgeError})`,
        );
      }
    }

    try {
      return await synthesizeWithSay(run, textFile, dir);
    } catch (error) {
      const sayError = error instanceof Error ? error.message : String(error);
      throw new Error(
        config.source === "edge-tts+say"
          ? `TTS: edge-tts failed after ${DEFAULT_TTS_ATTEMPTS} attempts (${edgeError}); say fallback failed (${sayError})`
          : `TTS: say failed (${sayError})`,
        { cause: error },
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // temp cleanup is best-effort — a failed synthesis result stands
    });
  }
}

/** Extra seams for tests; production calls populateVoiceTts() bare. */
export interface PopulateVoiceTtsOptions {
  settingsPath?: string;
  runCommand?: RunCommand;
}

/**
 * The single TTS wiring seam (index.ts calls it once at factory start).
 * Returns the synthesis hook when a source is configured, `undefined` when
 * synthesis is disabled (`source: "none"`) so the voice-refusal path
 * in tool-logic.ts stays intact.
 */
export function populateVoiceTts(
  opts: PopulateVoiceTtsOptions = {},
): VoiceTtsHook | undefined {
  const config = readVoiceTtsConfig(opts.settingsPath);
  if (config.source === "none") return undefined;
  const run = opts.runCommand ?? defaultRunCommand;
  return {
    synthesize: (text: string) => synthesizeVoice(text, config, run),
  };
}

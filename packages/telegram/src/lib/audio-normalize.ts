/**
 * audio-normalize.ts — quiet-audio pre-amplification for STT ().
 *
 * Telegram voice notes arrive near-silence to a distant mic; the initial
 * evidence showed raw transcription wobbling while +18 dB gain converged
 * three runs. ffmpeg pipes the bytes in and out (no temp files), fixed
 * volume=18dB, re-encoded to opus/ogg 48 kHz. ffmpeg absent → null (the
 * caller retries with the raw bytes silently — normalization is a
 * best-effort, never a blocker).
 */

/** Default fixed gain (dB) — the value that stabilized the original quiet clip. */
export const DEFAULT_STT_NORMALIZE_GAIN_DB = 18;

/**
 * ffmpeg argv for quiet-audio amplification: read ogg from stdin, apply the
 * fixed volume filter, emit opus/ogg to stdout. Exposed for tests (the brief
 * targets the arg builder; the spawn itself stays one shell invocation).
 */
export function buildFfmpegNormalizeArgs(
  gainDb: number = DEFAULT_STT_NORMALIZE_GAIN_DB,
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-af",
    `volume=${gainDb}dB`,
    "-c:a",
    "libopus",
    "-b:a",
    "24k",
    "-ar",
    "48000",
    "-f",
    "ogg",
    "pipe:1",
  ];
}

/** Options for normalizeAudioBytes (all optional; ffmpeg looked up on PATH). */
export interface NormalizeAudioBytesOptions {
  /** ffmpeg binary name/path (default "ffmpeg"). */
  ffmpegPath?: string;
  /** Fixed gain in dB (default 18). */
  gainDb?: number;
}

/**
 * Amplify quiet audio via ffmpeg stdin/stdout pipes. Returns the normalized
 * bytes, or null when ffmpeg is missing, the spawn fails, or the output is
 * empty — callers treat null as "skip normalization" silently.
 */
export async function normalizeAudioBytes(
  bytes: Uint8Array,
  opts: NormalizeAudioBytesOptions = {},
): Promise<Uint8Array | null> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolveNormalize) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        opts.ffmpegPath ?? "ffmpeg",
        buildFfmpegNormalizeArgs(opts.gainDb),
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      resolveNormalize(null); // ffmpeg absent — skip silently
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolveNormalize(null)); // ENOENT etc.
    child.on("close", (code) => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.byteLength > 0) {
        resolveNormalize(new Uint8Array(out));
      } else {
        resolveNormalize(null);
      }
    });
    child.stdin?.on("error", () => {
      /* spawn-race: the close handler still settles the promise */
    });
    child.stdin?.end(Buffer.from(bytes));
  });
}

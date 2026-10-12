/**
 * hostile-home-driver.mjs — child driver for state-root.test.mjs's hostile
 * HOME cases. Runs with HOME="" / "." / a relative path, BRAID_HOME unset and
 * a throwaway cwd, and prints one JSON line:
 *
 *   { homedir, paths: { <accessor>: <value|null> }, voice: <result> }
 *
 * The parent asserts every default refused (null) and that the voice writer
 * refused without creating anything in the cwd. Not a *.test.mjs file: the
 * runner never executes it directly.
 */
const paths = await import("../dist/lib/state-paths.js");
const voice = await import("../dist/lib/voice.js");
const os = await import("node:os");

const accessors = [
  "braidDir",
  "telegramStateDir",
  "defaultStateFilePath",
  "defaultLiveUpdateFilePath",
  "defaultMediaDir",
  "legacyMediaDir",
  "legacyPauseStateFile",
  "defaultPauseStateFile",
];
const resolved = {};
for (const name of accessors) resolved[name] = paths[name]();
resolved.resolveMediaReadPath = paths.resolveMediaReadPath("5.ogg");

/** getFile + download fake: the write is the only thing that can land. */
const fakeFetch = async (url) => {
  const text = String(url);
  if (text.includes("getFile")) {
    return new Response(
      JSON.stringify({
        ok: true,
        result: { file_id: "v1", file_path: "voice/file_1.ogg" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (text.includes("/file/bot")) {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }
  throw new Error(`unexpected url: ${text}`);
};

const result = await voice.materializeVoice({
  token: "test-token",
  updateId: 7,
  voice: { file_id: "v1" },
  fetchFn: fakeFetch,
});

process.stdout.write(
  JSON.stringify({ homedir: os.homedir(), paths: resolved, voice: result }) +
    "\n",
);

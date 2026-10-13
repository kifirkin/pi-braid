/**
 * state-root.test.mjs — braid state the telegram extension owns lives under
 * the braid root (BRAID_HOME when pinned), and the two relocations (media,
 * pause state) stay read-compatible with their pre-move location.
 *
 * The containment case is the runtime half of the write-scope evidence: with
 * BRAID_HOME pinned to one temp tree and the process chdir'd into another
 * (restored in a finally and in the file-level after hook), a real inbound
 * voice download (fake fetch, no network) must land in the pinned tree and
 * leave the cwd tree byte-for-byte unchanged. The process HOME is pinned to a
 * third tree before the modules load, so the legacy-location assertions can
 * never touch the live tree. The refusal cases run the same writers in a
 * child: a hostile HOME ("", "." or a relative path) with BRAID_HOME unset,
 * and a relative BRAID_HOME with an absolute HOME. Every default must refuse
 * (null) either way, the throwaway cwd must gain nothing, and the default
 * tree under the child's HOME must gain nothing either - a writer that fell
 * back to the module-load default rather than the accessor writes there.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BOT_TOKEN, jsonResponse, makeFakeFetch } from "./fixtures.mjs";

const REAL_HOME = process.env.HOME;
const REAL_BRAID_HOME = process.env.BRAID_HOME;
const REAL_CWD = process.cwd();
const HERE = dirname(fileURLToPath(import.meta.url));

let pin;
let projectDir;
let homeDir;
let paths;
let voice;
let pause;

/** Entry names, kinds and mtimes — a changed tree cannot look unchanged. */
function treeOf(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = join(dir, entry.name);
      return `${entry.name}:${entry.isDirectory() ? "dir" : "file"}:${statSync(full).mtimeMs}`;
    })
    .sort();
}

before(async () => {
  pin = mkdtempSync(join(tmpdir(), "tg-state-pin-"));
  projectDir = mkdtempSync(join(tmpdir(), "tg-state-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "tg-state-home-"));
  process.env.HOME = homeDir;
  process.env.BRAID_HOME = pin;
  paths = await import("../dist/lib/state-paths.js");
  voice = await import("../dist/lib/voice.js");
  pause = await import("../dist/lib/pause-control.js");
});

after(() => {
  process.chdir(REAL_CWD);
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  if (REAL_BRAID_HOME === undefined) delete process.env.BRAID_HOME;
  else process.env.BRAID_HOME = REAL_BRAID_HOME;
  for (const dir of [pin, projectDir, homeDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing the pin returns every default to the home root", () => {
  const saved = process.env.BRAID_HOME;
  delete process.env.BRAID_HOME;
  try {
    const braid = join(homeDir, ".pi", "agent", "braid");
    assert.equal(paths.braidDir(), braid);
    assert.equal(
      paths.defaultStateFilePath(),
      join(braid, "telegram-state.json"),
    );
    assert.equal(paths.defaultMediaDir(), join(braid, "telegram", "media"));
    assert.equal(
      paths.defaultPauseStateFile(),
      join(braid, "telegram", "pause-state.json"),
    );
    assert.equal(
      paths.legacyMediaDir(),
      join(homeDir, ".pi", "agent", "telegram-media"),
    );
  } finally {
    process.env.BRAID_HOME = saved;
  }
});

test("every telegram default resolves under the pinned braid root", () => {
  assert.equal(paths.braidDir(), pin);
  assert.equal(paths.telegramStateDir(), join(pin, "telegram"));
  assert.equal(paths.defaultMediaDir(), join(pin, "telegram", "media"));
  assert.equal(
    paths.defaultPauseStateFile(),
    join(pin, "telegram", "pause-state.json"),
  );
  // The offset/live-update files predate the move and stay where they were.
  assert.equal(paths.defaultStateFilePath(), join(pin, "telegram-state.json"));
  assert.equal(
    paths.defaultLiveUpdateFilePath(),
    join(pin, "telegram-live-update.json"),
  );
  // The pre-move roots resolve against HOME, never against the pin.
  assert.equal(
    paths.legacyMediaDir(),
    join(homeDir, ".pi", "agent", "telegram-media"),
  );
  assert.equal(
    paths.legacyPauseStateFile(),
    join(homeDir, ".pi", "agent", "telegram-pause-state.json"),
  );
});

test("an inbound voice download writes into the pin and never the cwd", async () => {
  const bytes = Buffer.from("OggS state-root fixture");
  const fetchFn = makeFakeFetch(async (url) => {
    if (url.includes("getFile")) {
      return jsonResponse({
        ok: true,
        result: { file_id: "v1", file_path: "voice/file_1.ogg" },
      });
    }
    if (url.includes("/file/bot")) {
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const updateId = 918273645;
  // The download must run with the throwaway project AS the process cwd,
  // otherwise the containment assertions below watch a directory no writer
  // can reach. Restored even when an assertion throws.
  process.chdir(projectDir);
  const cwdTree = treeOf(projectDir);
  const cwdMtime = statSync(projectDir).mtimeMs;

  let result;
  try {
    result = await voice.materializeVoice({
      token: BOT_TOKEN,
      updateId,
      voice: { file_id: "v1" },
      fetchFn,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(
      result.filePath,
      join(pin, "telegram", "media", `${updateId}.ogg`),
    );
    assert.deepEqual(
      new Uint8Array(readFileSync(result.filePath)),
      new Uint8Array(bytes),
    );
    // Containment: the cwd tree is untouched (names + mtimes).
    assert.deepEqual(treeOf(projectDir), cwdTree);
    assert.equal(statSync(projectDir).mtimeMs, cwdMtime);
    assert.equal(existsSync(join(projectDir, ".pi")), false);
    // The pre-move media root received nothing.
    assert.equal(
      existsSync(join(paths.legacyMediaDir(), `${updateId}.ogg`)),
      false,
    );
  } finally {
    process.chdir(REAL_CWD);
  }
});

test("media reads prefer the braid root and fall back to the pre-move file", () => {
  const legacyFile = join(paths.legacyMediaDir(), "5.ogg");
  mkdirSync(paths.legacyMediaDir(), { recursive: true });
  writeFileSync(legacyFile, "legacy");
  assert.equal(paths.resolveMediaReadPath("5.ogg"), legacyFile);

  const currentFile = join(paths.defaultMediaDir(), "5.ogg");
  mkdirSync(paths.defaultMediaDir(), { recursive: true });
  writeFileSync(currentFile, "current");
  assert.equal(paths.resolveMediaReadPath("5.ogg"), currentFile);

  // A miss resolves against the write target, never against the cwd.
  assert.equal(
    paths.resolveMediaReadPath("missing.ogg"),
    join(paths.defaultMediaDir(), "missing.ogg"),
  );
  const absent = join(projectDir, "absent.ogg");
  assert.equal(paths.resolveMediaReadPath(absent), absent);
});

test("pause state writes to the braid root and reads the pre-move file first", async () => {
  const legacyPause = paths.legacyPauseStateFile();
  mkdirSync(dirname(legacyPause), { recursive: true });
  writeFileSync(legacyPause, JSON.stringify({ paused: true, updatedAt: 1 }));

  // Read resolution falls back while the braid-root file is absent...
  assert.equal(pause.resolvePauseStateReadFile(), legacyPause);
  assert.deepEqual(await pause.getPauseState(), { paused: true, updatedAt: 1 });
  // ...but the write target is always the braid root.
  const writePath = pause.resolvePauseStateFile();
  assert.equal(writePath, join(pin, "telegram", "pause-state.json"));

  await pause.savePauseState(writePath, { paused: false, updatedAt: 2 });
  assert.equal(existsSync(writePath), true);
  // Once written, the braid-root file wins; the legacy copy is never touched.
  assert.equal(pause.resolvePauseStateReadFile(), writePath);
  assert.deepEqual(await pause.getPauseState(), {
    paused: false,
    updatedAt: 2,
  });
  assert.deepEqual(JSON.parse(readFileSync(legacyPause, "utf8")), {
    paused: true,
    updatedAt: 1,
  });
});

test("a hostile HOME refuses every default and writes nothing into the cwd", () => {
  for (const home of ["", ".", "rel-home"]) {
    const project = mkdtempSync(join(tmpdir(), "tg-hostile-cwd-"));
    const env = { ...process.env, HOME: home };
    delete env.BRAID_HOME;
    try {
      const r = spawnSync("node", [join(HERE, "hostile-home-driver.mjs")], {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(r.status, 0, `${JSON.stringify(home)}: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim().split("\n").pop());
      for (const [name, value] of Object.entries(out.paths)) {
        assert.equal(
          value,
          null,
          `${JSON.stringify(home)}: ${name} -> ${value}`,
        );
      }
      assert.equal(
        out.voice.ok,
        false,
        `${JSON.stringify(home)}: the voice writer must refuse`,
      );
      assert.deepEqual(
        readdirSync(project),
        [],
        `${JSON.stringify(home)}: the cwd gained ${readdirSync(project)}`,
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
});

test("a relative BRAID_HOME refuses every default and reaches no writer", () => {
  // The override leg of the same contract, and the writer-level half of the
  // mirror suite's matrix: the suite pins the accessor's refusal, this drives
  // the writers that consume it. A relative BRAID_HOME resolves against
  // whatever cwd the process has, so the poller lock, the media dir, the
  // pause state and the live-update state would all land in the session's
  // project. HOME is absolute here, so the refusal must come from the
  // override leg and the default tree under HOME must stay empty: a writer
  // folded to the module-load default writes there instead.
  const home = mkdtempSync(join(tmpdir(), "tg-relpin-home-"));
  const project = mkdtempSync(join(tmpdir(), "tg-relpin-cwd-"));
  const env = { ...process.env, HOME: home, BRAID_HOME: "rel-pin" };
  try {
    const r = spawnSync("node", [join(HERE, "hostile-home-driver.mjs")], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    // Every default the braid root owns refuses. The two legacy accessors
    // (pre-move, HOME-based, read-only) keep resolving under this absolute
    // HOME instead, and the point of the guard is that neither resolves
    // inside the project the reader ran in.
    for (const name of [
      "braidDir",
      "telegramStateDir",
      "defaultStateFilePath",
      "defaultLiveUpdateFilePath",
      "defaultMediaDir",
      "defaultPauseStateFile",
      "resolveMediaReadPath",
    ]) {
      assert.equal(
        out.paths[name],
        null,
        `rel-pin: ${name} -> ${out.paths[name]}`,
      );
    }
    assert.equal(
      out.paths.legacyMediaDir,
      join(home, ".pi", "agent", "telegram-media"),
      "rel-pin: the legacy read path stays under the absolute HOME",
    );
    assert.equal(
      out.paths.legacyPauseStateFile,
      join(home, ".pi", "agent", "telegram-pause-state.json"),
      "rel-pin: the legacy pause path stays under the absolute HOME",
    );
    for (const [name, value] of Object.entries(out.paths)) {
      assert.ok(
        value === null || !String(value).startsWith(project),
        `rel-pin: ${name} resolves inside the project: ${value}`,
      );
    }
    assert.equal(out.voice.ok, false, "rel-pin: the voice writer must refuse");
    assert.deepEqual(
      readdirSync(project),
      [],
      `rel-pin: the cwd gained ${readdirSync(project)}`,
    );
    assert.equal(
      existsSync(join(home, ".pi", "agent", "braid")),
      false,
      "rel-pin: a folded writer must not reach the default tree under HOME",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

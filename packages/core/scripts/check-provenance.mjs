#!/usr/bin/env node
/**
 * check-provenance.mjs — every packable package must ship the provenance
 * record, and must generate it for the pack.
 *
 * The registry artifact is the claim that matters: what a stranger installs
 * should say what it was built from. Two things make that true per workspace
 * manifest, and this check fails when either is missing:
 *   - the `files` allowlist names build-info.json, so the record is inside the
 *     tarball instead of filtered out of it;
 *   - `prepack` generates it through the shared writer and `postpack` removes
 *     it again, so a pack leaves the tree as it found it and `npm publish`
 *     (which runs prepack, and does not run prepublishOnly's siblings for a
 *     plain pack) ships what `npm pack` ships.
 *
 * The writer is also executed once, in a throwaway package directory, because
 * a manifest that names a script which writes nothing would pass a purely
 * lexical read. The probe proves the record takes the version of the manifest
 * it runs in and that `remove` takes it away again.
 *
 * Reading the wiring is not the same as holding the artifact. npm's pack
 * order is prepack -> prepare -> postpack, with the tarball built after
 * `prepare`, so a hook between the two can take the record out of the
 * tarball. Every packable manifest therefore also packs a fixture of itself —
 * its `files` allowlist, its `prepare` body when it declares one, the shared
 * writer as its prepack/postpack pair — through npm's own `npm pack`, and the
 * tarball must carry the record. Nothing of the real package is built: the
 * fixture is package.json, a README and the record. A second pack of the same
 * fixture plants a record that already names the pack, edits the tree, and
 * requires the shipped `dirty` to come from the fresh pack-time read. A
 * leaked record is gitignored, so only an artifact can settle that.
 *
 * Population: every `packages/<dir>/package.json` that is not `private` — the
 * root manifest is the private monorepo root and is never packed. The
 * workspace list is discovered, never hardcoded, so a new package is covered
 * by existing.
 *
 * Bounds: the command bodies are read with a small shell-splitting tokenizer
 * (boundaries `&&`, `||`, `;`, newline; whitespace-separated words). A manifest
 * that spells its prepack some other way fails this check rather than passing
 * unread — the failure names what could not be read.
 *
 * Usage: node packages/core/scripts/check-provenance.mjs
 * Exit code: 0 = every packable package ships and generates the record, 1 = not.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");
const BUILD_INFO_FILE = "build-info.json";

const problems = [];
const fail = (message) => problems.push(message);

function readJSON(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every non-private workspace package: the set a registry install can receive. */
function packablePackages() {
  const parent = join(root, "packages");
  const found = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(parent, entry.name);
    const manifest = readJSON(join(dir, "package.json"));
    if (!manifest) continue;
    if (manifest.private === true) continue;
    found.push({ dir, rel: relative(root, join(dir, "package.json")), manifest });
  }
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** The words a script body runs, one list per shell command in the body. */
function commandWords(body) {
  return body
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

/**
 * The invocation of the shared writer inside a lifecycle script: the path it
 * is called with and the verb it is given. `null` when the body carries no
 * `node <path>.mjs <verb>` call at all — the caller reports that as a miss.
 */
function writerCall(body, pkgDir) {
  for (const words of commandWords(body)) {
    const call = words.findIndex(
      (word, i) => word === "node" && typeof words[i + 1] === "string" && words[i + 1].endsWith(".mjs"),
    );
    if (call === -1) continue;
    return {
      script: resolve(pkgDir, words[call + 1]),
      verb: words[call + 2] ?? null,
      text: words.slice(call, call + 3).join(" "),
    };
  }
  return null;
}

/** Single-quote a path for a POSIX shell command body. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Pack a fixture of one manifest through npm's own `npm pack` and return a
 * problem string when the tarball does not carry a good record.
 *
 * The fixture holds that manifest's `files` allowlist, its `prepare` body
 * when it declares one, and the shared writer as its prepack/postpack pair:
 * a package is packed by the lifecycle it declares, so a hook this gate never
 * read can still decide what the tarball holds. Nothing of the real package
 * is built — the fixture is package.json, a README and the record — and the
 * only commands it runs are the writer and that prepare body.
 *
 * The fixture is its own git work tree, so the record's sha and dirty are
 * asserted against the tree npm packed. When `proveRegeneration` is set, a
 * second pack writes a record that already names the pack and then edits the
 * tree: the shipped `dirty` must come from the pack-time read, not from the
 * record on disk, or a leftover from a killed postpack would make a dirty
 * tree ship `dirty: false`. One fixture carries that arm; the writer is
 * shared, and one pack per manifest already binds the allowlists and
 * prepares.
 *
 * Bounds, both fail-closed: a `prepare` that needs the real package's files
 * or scripts makes npm fail this pack, and npm configuration that suppresses
 * lifecycle scripts (e.g. `ignore-scripts`) fails it the way it strips the
 * record from a real pack.
 */
function packProbe({ writer, rel, manifest, proveRegeneration }) {
  const name = "provenance-pack-probe";
  const version = "0.0.0";
  const tarballName = `${name}-${version}.tgz`;
  const work = mkdtempSync(join(tmpdir(), "check-provenance-pack-"));
  const fixture = join(work, "fixture");
  const dest = join(work, "dest");

  const outTail = (text) => (text ?? "").trim().split("\n").slice(-4).join(" | ");
  const pack = () =>
    spawnSync("npm", ["pack", "--pack-destination", dest], {
      cwd: fixture,
      env: { ...process.env, npm_config_cache: join(work, "npm-cache") },
      encoding: "utf8",
      timeout: 120_000,
    });
  const tarballRecord = () => {
    const extracted = spawnSync("tar", ["-xzOf", join(dest, tarballName), `package/${BUILD_INFO_FILE}`], {
      encoding: "utf8",
    });
    if (extracted.status !== 0) return null;
    try {
      return JSON.parse(extracted.stdout);
    } catch {
      return null;
    }
  };

  mkdirSync(fixture);
  mkdirSync(dest);
  try {
    const scripts = {
      prepack: `node ${shellQuote(writer)} write`,
      postpack: `node ${shellQuote(writer)} remove`,
    };
    const prepare = manifest.scripts?.prepare;
    if (typeof prepare === "string" && prepare.trim() !== "") scripts.prepare = prepare;
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify(
        { name, version, files: Array.isArray(manifest.files) ? manifest.files : [], scripts },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(fixture, "README.md"), "# provenance pack probe\n");

    const gitSteps = [
      ["-c", "init.defaultBranch=main", "init", "-q"],
      ["add", "-A"],
      ["-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-q", "-m", "probe"],
    ];
    for (const args of gitSteps) {
      const step = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
      if (step.status !== 0) {
        return `${rel}: the pack probe's fixture could not be committed (git exited ${step.status}): ${outTail(step.stderr)}`;
      }
    }
    const head = (spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).stdout ?? "").trim();
    if (!head) return `${rel}: the pack probe's fixture has no commit to read`;

    const packed = pack();
    if (packed.status !== 0) {
      return `${rel}: the pack probe (npm pack, fixture wired like this manifest) exited ${packed.status}: ${outTail(packed.stderr) || outTail(packed.stdout)}`;
    }
    const listing = spawnSync("tar", ["-tzf", join(dest, tarballName)], { encoding: "utf8" });
    if (listing.status !== 0 || !listing.stdout.split("\n").includes(`package/${BUILD_INFO_FILE}`)) {
      return (
        `${rel}: the tarball a real pack produces carries no ${BUILD_INFO_FILE} — a hook npm runs between ` +
        `prepack and the tarball (prepare), or configuration suppressing the scripts, took the record away`
      );
    }
    const info = tarballRecord();
    if (!info) return `${rel}: the pack probe could not read a valid ${BUILD_INFO_FILE} out of the tarball`;
    if (info.name !== name || info.version !== version) {
      return `${rel}: the packed record names ${info.name}@${info.version}, the packed fixture is ${name}@${version}`;
    }
    if (info.sha !== head) {
      return `${rel}: the packed record carries sha ${info.sha}, the fixture's commit is ${head}`;
    }
    if (info.dirty !== false) {
      return `${rel}: the pack probe's tree was clean and the record says dirty=${info.dirty}`;
    }

    // A record that already names this pack, plus one edit. The shipped record
    // must be regenerated: deferring to the leftover would ship the dirty
    // flag of a tree that no longer exists.
    if (!proveRegeneration) return null;
    writeFileSync(join(fixture, BUILD_INFO_FILE), JSON.stringify(info, null, 2) + "\n");
    writeFileSync(join(fixture, "README.md"), "# provenance pack probe\nedited\n");
    const repacked = pack();
    if (repacked.status !== 0) {
      return `${rel}: the pack probe's second pack exited ${repacked.status}: ${outTail(repacked.stderr) || outTail(repacked.stdout)}`;
    }
    const dirty = tarballRecord();
    if (!dirty) {
      return `${rel}: the second pack's tarball carries no ${BUILD_INFO_FILE} (a leftover record made the pack defer)`;
    }
    if (dirty.dirty !== true) {
      return `${rel}: a leftover record made an edited tree ship dirty=${dirty.dirty}, not dirty=true`;
    }
    return null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const packages = packablePackages();
if (packages.length === 0) fail("packages/: no packable package manifest found");

const writers = new Map();

for (const { dir, rel, manifest } of packages) {
  if (!Array.isArray(manifest.files) || !manifest.files.includes(BUILD_INFO_FILE)) {
    fail(`${rel}: the files allowlist does not name ${BUILD_INFO_FILE}`);
  }

  const scripts = manifest.scripts ?? {};
  for (const [hook, verb] of [
    ["prepack", "write"],
    ["postpack", "remove"],
  ]) {
    const body = scripts[hook];
    if (typeof body !== "string" || body.trim() === "") {
      fail(`${rel}: no ${hook} script, so ${BUILD_INFO_FILE} is not ${verb === "write" ? "generated" : "removed"}`);
      continue;
    }
    const call = writerCall(body, dir);
    if (!call) {
      fail(`${rel}: ${hook} ("${body}") does not call a node script`);
      continue;
    }
    if (call.verb !== verb) {
      fail(`${rel}: ${hook} ("${body}") does not give the writer the "${verb}" verb (read: "${call.text}")`);
      continue;
    }
    if (!existsSync(call.script)) {
      fail(`${rel}: ${hook} calls ${call.text}, and ${relative(root, call.script)} does not exist`);
      continue;
    }
    if (!writers.has(rel)) writers.set(rel, call.script);
  }
}

// One writer for the whole workspace: a second generator could write a
// different record for the same version, which is the drift this gate exists
// to refuse.
const distinct = [...new Set(writers.values())];
if (distinct.length > 1) {
  const named = [...writers].map(([rel, file]) => `${rel} -> ${relative(root, file)}`);
  fail(`the packages do not share one writer: ${named.join("; ")}`);
}

// That one writer must reach the shared generator rather than carry a copy of
// it: the record's shape is build-info.mjs's, and a fork of it would keep
// passing the field checks below while the two could drift apart.
if (distinct.length === 1) {
  const [writer] = distinct;
  const source = readFileSync(writer, "utf8");
  const specifier = /from\s+["']([^"']*build-info\.mjs)["']/.exec(source)?.[1] ?? null;
  if (!specifier) {
    fail(`${relative(root, writer)} does not import the shared build-info.mjs generator`);
  } else {
    const generator = resolve(dirname(writer), specifier);
    if (!existsSync(generator)) {
      fail(`${relative(root, writer)} imports ${specifier}, and ${relative(root, generator)} does not exist`);
    } else {
      const module = await import(generator);
      for (const name of ["readGitProvenance", "writeBuildInfo"]) {
        if (typeof module[name] !== "function") {
          fail(`${relative(root, generator)} does not export ${name}()`);
        }
      }
    }
  }
}

// The probe. A manifest can name a writer that writes nothing; running it
// against a package of its own is what separates the two. The environment is
// npm's: a lifecycle script is handed the manifest it acts on in
// npm_package_json, and the writer takes the version to record from there.
if (distinct.length === 1) {
  const [writer] = distinct;
  const probeDir = mkdtempSync(join(tmpdir(), "check-provenance-"));
  const probeEnv = { ...process.env, npm_package_json: join(probeDir, "package.json") };
  try {
    const name = "provenance-probe";
    const version = "9.9.9";
    writeFileSync(join(probeDir, "package.json"), JSON.stringify({ name, version }, null, 2) + "\n");
    const written = spawnSync(process.execPath, [writer, "write"], { cwd: probeDir, env: probeEnv, encoding: "utf8" });
    if (written.status !== 0) {
      fail(`${relative(root, writer)} write exited ${written.status}: ${(written.stderr ?? "").trim()}`);
    } else {
      const info = readJSON(join(probeDir, BUILD_INFO_FILE));
      if (!info) fail(`${relative(root, writer)} write produced no ${BUILD_INFO_FILE}`);
      else {
        if (info.name !== name) fail(`the record names "${info.name}", the manifest says "${name}"`);
        if (info.version !== version) fail(`the record says version ${info.version}, the manifest says ${version}`);
        for (const field of ["sha", "branch", "dirty", "packedAt"]) {
          if (!(field in info)) fail(`the record carries no "${field}" field`);
        }
      }
    }
    const removed = spawnSync(process.execPath, [writer, "remove"], {
      cwd: probeDir,
      env: probeEnv,
      encoding: "utf8",
    });
    if (removed.status !== 0) {
      fail(`${relative(root, writer)} remove exited ${removed.status}: ${(removed.stderr ?? "").trim()}`);
    } else if (existsSync(join(probeDir, BUILD_INFO_FILE))) {
      fail(`${relative(root, writer)} remove left ${BUILD_INFO_FILE} behind`);
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// The artifact probe. The arms above read the wiring; this one holds what the
// wiring produces. Each packable manifest is packed once through npm's own
// lifecycle — its allowlist, its `prepare` body, the shared writer — and the
// tarball must carry a record read from the tree that was packed.
if (distinct.length === 1) {
  const [writer] = distinct;
  packages.forEach(({ rel, manifest }, index) => {
    const problem = packProbe({ writer, rel, manifest, proveRegeneration: index === 0 });
    if (problem) fail(problem);
  });
}

if (problems.length > 0) {
  console.error(`check-provenance: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `check-provenance: ${packages.length} packable package(s) ship ${BUILD_INFO_FILE} ` +
    `(${packages.map((p) => p.manifest.name).join(", ")}) through one writer`,
);

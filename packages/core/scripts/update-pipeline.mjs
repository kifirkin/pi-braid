#!/usr/bin/env node
/**
 * update-pipeline.mjs -- the codified pi-runtime update pipeline for the
 * pi-braid pair (the extension pack plus the pi runtime it hosts on).
 *
 * Why the two moves are one move: braid resolves its pi-family imports from
 * ~/.pi/agent/local-packages, and its manifests declare those packages as `*`
 * peers, so installing a new braid tarball never moves the resolved copies.
 * The pins that matter live in <local-packages>/package.json as explicit
 * dependencies. Updating the runtime alone leaves braid importing helpers from
 * a different version than the host, and updating only braid leaves the host
 * behind. So this pipeline aligns the pins on both sides, republishes braid,
 * and moves the runtime LAST. Aligning a pin is not the whole move: the
 * resolution behind it (the repo's node_modules + lockfile, and the
 * local-packages copies) must be reconciled too, so `--apply` runs `npm
 * install` on both sides before republishing.
 *
 * Modes:
 *   (default)  plan: resolve the upstream pi version, compare it against the
 *              repo pins and the local-packages resolution, print the target,
 *              every pin that would change, the braid version bump, the publish
 *              commands, the runtime command, and the rollback commands.
 *              Read-only: it writes nothing.
 *   --apply    perform the repo and local-packages edits, reconcile both
 *              resolutions (`npm install` at the repo root and in
 *              local-packages), and run the local publishes. Stages the
 *              rollback directory before touching local-packages. Requires
 *              --yes. The runtime is left untouched.
 *   --runtime  additionally run the runtime update (`pi update`). Refused
 *              unless --apply is also given.
 *   --verify   static half of the smoke checklist against the installed pair;
 *              exits non-zero when any item fails. The live-session items are
 *              printed as a checklist for a human to run, never automated.
 *
 * Never launches a pi process except the runtime update under `--apply
 * --runtime`. In particular `--verify` reads the installed tree statically
 * rather than driving a session: a nested pi session started from a script has
 * stalled the seat before, and module resolution at process start is the only
 * insulation this pipeline can honestly claim.
 *
 * Test/env hooks (no config file, no schema; every default is the live value):
 *   UPDATE_REPO_ROOT        repo whose manifests are edited (default: this repo)
 *   LOCAL_PKG               local-packages tree (default: ~/.pi/agent/local-packages)
 *   PI_CODING_AGENT_DIR     agent dir holding settings.json (default: ~/.pi/agent)
 *   UPDATE_TARGET_VERSION   upstream version, skips the `npm view` lookup
 *   UPDATE_RUNTIME_VERSION  installed runtime version, skips the prefix lookup
 *   UPDATE_TYPEBOX_VERSION  typebox floor for the peer ranges, skips the
 *                           workspace-pin lookup
 *   UPDATE_NPM              npm binary used for installs (default: npm)
 *
 * Usage:
 *   node packages/core/scripts/update-pipeline.mjs                     # plan
 *   node packages/core/scripts/update-pipeline.mjs --apply --yes
 *   node packages/core/scripts/update-pipeline.mjs --verify
 *   node packages/core/scripts/update-pipeline.mjs --apply --runtime --yes
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** pi packages braid resolves at runtime through local-packages. */
const PI_FAMILY = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];
/** The host packages the workspace manifests peer-declare: the family plus pi-tui. */
const PI_FAMILY_PEERS = [...PI_FAMILY, "@earendil-works/pi-tui"];
const UPSTREAM_RUNTIME_PKG = "@earendil-works/pi-coding-agent";
/** Braid workspace packages, in publish order. */
const BRAID_PACKAGES = ["core", "providers", "skills", "telegram", "contrib"];
/** The host family's typebox peer, on its own version line. */
const TYPEBOX = "typebox";
/** The runtime update, owned by the global npm prefix under mise. */
const RUNTIME_CMD = { bin: "pi", args: ["update"] };

/** A caret floor on the version the targets name. */
const caretRange = (v) => `^${v}`;

/**
 * The repo pins that moved in the last real alignment, plus the range surfaces
 * the runtime's own number owns.
 *
 * The host family is a peer in every workspace manifest, and a peer is
 * resolved: an open `*` there hands a registry install whatever the registry's
 * newest is, including a new major the extension was never loaded against. The
 * caret floor is the host's own compatibility claim rather than a looser one —
 * pi-coding-agent declares its internals as `^<its version>` (pi-ai `^1.2.0`
 * today) — while an exact pin would foreclose patch fixes and a tilde would
 * refuse the family the registry currently serves. Rewriting them here is what
 * keeps them moving with the runtime instead of drifting behind it.
 *
 * typebox rides the host family but not the runtime's version: its floor is
 * the version the workspace already pins for its own suites (a dev dependency,
 * read by resolveTypeboxFloor), so the peer range and that pin cannot drift
 * apart. Contrib's `pi-braid` peer is the pack beside it rather than the host,
 * and is left open deliberately.
 */
const REPO_PIN_SPECS = [
  { file: "package.json", field: "dependencies", packages: PI_FAMILY, wrap: (v) => v },
  {
    // The providers package typechecks its pi-ai imports against the runtime it
    // loads beside; leaving this caret behind lets a later repo install resolve
    // a pi-ai older than the runtime. It is a no-op on today's resolution
    // (`^0.87.0` already admits 0.87.1) but keeps the two surfaces from
    // drifting apart on the next move.
    file: "packages/providers/package.json",
    field: "devDependencies",
    packages: ["@earendil-works/pi-ai"],
    wrap: (v) => `^${v}`,
  },
  // One pair of specs per workspace, discovered from BRAID_PACKAGES: a
  // manifest that adds or drops a host peer is already owned by the next plan.
  ...BRAID_PACKAGES.flatMap((dir) => [
    { file: `packages/${dir}/package.json`, field: "peerDependencies", packages: PI_FAMILY_PEERS, wrap: caretRange },
    {
      file: `packages/${dir}/package.json`,
      field: "peerDependencies",
      packages: [TYPEBOX],
      wrap: caretRange,
      target: "typebox",
    },
  ]),
];
/** The explicit pi-family pins in the local-packages manifest. */
const LOCAL_PIN_SPECS = [
  { file: "package.json", field: "dependencies", packages: PI_FAMILY, wrap: (v) => v },
];

const REPO_ROOT = process.env.UPDATE_REPO_ROOT
  ? path.resolve(process.env.UPDATE_REPO_ROOT)
  : path.resolve(SCRIPT_DIR, "..", "..", "..");
const LOCAL_PACKAGES = process.env.LOCAL_PKG
  ? path.resolve(process.env.LOCAL_PKG)
  : path.join(os.homedir(), ".pi", "agent", "local-packages");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), ".pi", "agent");
const NPM = process.env.UPDATE_NPM && process.env.UPDATE_NPM.trim() ? process.env.UPDATE_NPM : "npm";

// --- helpers ----------------------------------------------------------------

function run(bin, args, opts = {}) {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch {
    return "";
  }
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function fail(msg, code = 2) {
  console.error(`[update-pipeline] ERROR: ${msg}`);
  process.exit(code);
}

function say(msg = "") {
  console.log(`[update-pipeline] ${msg}`);
}

// --- version surfaces -------------------------------------------------------

/** Upstream pi version. One `npm view`, in a throwaway cache so plan mode
 *  leaves no trace in the user's cache. */
function resolveTarget() {
  if (process.env.UPDATE_TARGET_VERSION) return process.env.UPDATE_TARGET_VERSION.trim();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "update-pipeline-npm-"));
  try {
    const v = run(NPM, ["view", UPSTREAM_RUNTIME_PKG, "version"], {
      env: { ...process.env, npm_config_cache: cache },
    });
    if (!v) fail("cannot resolve the upstream pi version (npm view returned nothing)");
    return v.split("\n").pop().trim();
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

/** Installed runtime version, read from the global prefix statically. Reading
 *  it must not launch pi: `pi --version` is a pi process. */
function resolveRuntimeVersion() {
  if (process.env.UPDATE_RUNTIME_VERSION) return process.env.UPDATE_RUNTIME_VERSION.trim();
  const prefix = run(NPM, ["prefix", "-g"]);
  if (!prefix) return "unknown";
  const manifest = path.join(
    prefix,
    "lib",
    "node_modules",
    ...UPSTREAM_RUNTIME_PKG.split("/"),
    "package.json",
  );
  return readJSON(manifest)?.version ?? "unknown";
}

/**
 * The typebox floor the peer ranges declare. typebox is not part of the pi
 * runtime family and does not move with its number: the floor is the version
 * the workspace already pins for its own suites (packages/telegram's dev
 * dependency, which is also what the repo's node_modules resolves), so the peer
 * range and that pin cannot drift apart. `null` when the pin is absent or is
 * not a version — an unknown floor is written nowhere.
 */
function resolveTypeboxFloor() {
  const override = process.env.UPDATE_TYPEBOX_VERSION;
  const declared =
    override && override.trim()
      ? override.trim()
      : (readJSON(path.join(REPO_ROOT, "packages", "telegram", "package.json"))?.devDependencies?.[
          TYPEBOX
        ] ?? "");
  const floor = String(declared).replace(/^[\^~]/, "");
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(floor) ? floor : null;
}

/** The version set one run aligns to. */
function resolveTargets() {
  return { pi: resolveTarget(), typebox: resolveTypeboxFloor() };
}

function installedPiVersion(name) {
  const manifest = path.join(LOCAL_PACKAGES, "node_modules", ...name.split("/"), "package.json");
  return readJSON(manifest)?.version ?? null;
}

function repoPiVersion(name) {
  const manifest = path.join(REPO_ROOT, "node_modules", ...name.split("/"), "package.json");
  return readJSON(manifest)?.version ?? null;
}

function installedBraidVersions() {
  const out = {};
  for (const dir of BRAID_PACKAGES) {
    const repoPkg = readJSON(path.join(REPO_ROOT, "packages", dir, "package.json"));
    if (!repoPkg?.name) continue;
    const installed = readJSON(
      path.join(LOCAL_PACKAGES, "node_modules", ...repoPkg.name.split("/"), "package.json"),
    );
    out[dir] = { name: repoPkg.name, repo: repoPkg.version ?? null, installed: installed?.version ?? null };
  }
  return out;
}

// --- pin diff ---------------------------------------------------------------

/**
 * What one spec comes to in one tree: the manifest it reads, and one row per
 * package that manifest actually declares — the field path, the value now, and
 * the range the targets imply. Plan and apply read the same rows, so what the
 * plan prints is what apply writes; a spec whose target is unknown, or whose
 * manifest declares none of its packages, yields no rows and leaves the file
 * alone, and a manifest that is absent or unreadable is not guessed at.
 */
function specRows(baseDir, spec, targets) {
  const absPath = path.join(baseDir, spec.file);
  const manifest = readJSON(absPath);
  const target = targets[spec.target ?? "pi"];
  const to = target ? spec.wrap(target) : null;
  const group = manifest?.[spec.field] ?? {};
  const rows =
    manifest && to !== null
      ? spec.packages
          .filter((name) => group[name] !== undefined)
          .map((name) => ({ field: `${spec.field}.${name}`, from: group[name], to }))
      : [];
  return { absPath, manifest, rows };
}

/**
 * The pin changes an apply would write: the current value and the value the
 * target version implies. `wrap` expresses the range form the field uses
 * (exact for the root resolution, caret for a peer range).
 */
function pinChanges(baseDir, specs, targets) {
  const changes = [];
  for (const spec of specs) {
    for (const row of specRows(baseDir, spec, targets).rows) {
      if (row.from === row.to) continue;
      changes.push({ file: spec.file, field: row.field, from: row.from, to: row.to });
    }
  }
  return changes;
}

// --- braid version bump -----------------------------------------------------

function currentBranch(repoRoot) {
  const b = run("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!b || b === "HEAD") return "detached";
  return b.replace(/[^a-zA-Z0-9.-]/g, "-");
}

function commitsSinceMain(repoRoot) {
  const n = run("git", ["-C", repoRoot, "rev-list", "--count", "main..HEAD"]);
  return /^\d+$/.test(n) ? n : "0";
}

/**
 * The release bump. A manifest already carrying a full release string is
 * incremented in place (`0.3.2-main.21` -> `0.3.2-main.22`); a plain base gets
 * the same `<base>-<branch>.<commits>` suffix publish-local would derive.
 */
function nextCoreVersion(current, branch, commits) {
  if (/^\d+\.\d+\.\d+-.*\.\d+$/.test(current)) {
    return current.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  }
  return `${current}-${branch}.${commits}`;
}

function coreVersionInfo() {
  const manifestPath = path.join(REPO_ROOT, "packages", "core", "package.json");
  const manifest = readJSON(manifestPath);
  if (!manifest) fail(`cannot read ${manifestPath}`);
  const from = manifest.version ?? "unknown";
  const to = nextCoreVersion(from, currentBranch(REPO_ROOT), commitsSinceMain(REPO_ROOT));
  return { file: "packages/core/package.json", field: "version", from, to };
}

// --- commands ---------------------------------------------------------------

function publishCommands() {
  return BRAID_PACKAGES.map(
    (dir) => `node packages/core/scripts/publish-local.mjs ${dir}`,
  );
}

function rollbackDirName(target) {
  const date = new Date().toISOString().slice(0, 10);
  return `backup-${date}-pre${target.replace(/\./g, "")}`;
}

function rollbackLines(backupDir, runtimeVersion, target) {
  const nm = path.join(LOCAL_PACKAGES, "node_modules");
  const prefix = run(NPM, ["prefix", "-g"]);
  return [
    `# Staged rollback; not exercised. Backup: ${backupDir}`,
    "# braid packages, per backed-up directory:",
    `#   rm -rf ${nm}/<name> && cp -R ${backupDir}/<name> ${nm}/<name>`,
    `# or reinstall the pinned tarballs: cd ${LOCAL_PACKAGES} && npm install`,
    "# runtime:",
    prefix
      ? `#   npm --prefix ${prefix} install -g ${UPSTREAM_RUNTIME_PKG}@${runtimeVersion}`
      : `#   npm install -g ${UPSTREAM_RUNTIME_PKG}@${runtimeVersion}`,
    `# (was targeting ${target})`,
  ];
}

// --- the plan ---------------------------------------------------------------

function buildPlan() {
  const targets = resolveTargets();
  const target = targets.pi;
  const runtime = resolveRuntimeVersion();
  const repoChanges = pinChanges(REPO_ROOT, REPO_PIN_SPECS, targets);
  const localChanges = pinChanges(LOCAL_PACKAGES, LOCAL_PIN_SPECS, targets);
  const repoPins = PI_FAMILY.map((name) => {
    const manifest = readJSON(path.join(REPO_ROOT, "package.json"));
    return { name, pin: manifest?.dependencies?.[name] ?? null, resolved: repoPiVersion(name) };
  });
  const localPins = PI_FAMILY.map((name) => {
    const manifest = readJSON(path.join(LOCAL_PACKAGES, "package.json"));
    return { name, pin: manifest?.dependencies?.[name] ?? null, resolved: installedPiVersion(name) };
  });
  return {
    target,
    targets,
    runtime,
    repoChanges,
    localChanges,
    repoPins,
    localPins,
    coreVersion: coreVersionInfo(),
    braid: installedBraidVersions(),
    publishCommands: publishCommands(),
    runtimeCommand: `${RUNTIME_CMD.bin} ${RUNTIME_CMD.args.join(" ")}`,
    backupDir: path.join(LOCAL_PACKAGES, rollbackDirName(target)),
  };
}

function mark(ok) {
  return ok ? "ok" : "DRIFT";
}

function printPlan(plan, { applied = false } = {}) {
  say(`repo root: ${REPO_ROOT}`);
  say(`local-packages: ${LOCAL_PACKAGES}`);
  say(`target (upstream ${UPSTREAM_RUNTIME_PKG}): ${plan.target}`);
  say(
    `typebox peer floor: ${plan.targets.typebox ?? "unresolved (the typebox peer ranges are left alone)"}`,
  );
  say(`runtime pi: ${plan.runtime} (${mark(plan.runtime === plan.target)})`);
  say(`mode: ${applied ? "apply" : "plan (read-only; nothing is written)"}`);
  say();

  say(`repo resolution (${mark(plan.repoPins.every((p) => p.resolved === plan.target))}):`);
  for (const p of plan.repoPins) {
    say(`  ${p.name.replace("@earendil-works/", "").padEnd(24)} pin ${String(p.pin).padEnd(10)} resolved ${p.resolved ?? "unresolved"}`);
  }
  say(`local-packages resolution (${mark(plan.localPins.every((p) => p.resolved === plan.target))}):`);
  for (const p of plan.localPins) {
    say(`  ${p.name.replace("@earendil-works/", "").padEnd(24)} pin ${String(p.pin).padEnd(10)} copy  ${p.resolved ?? "not installed"}`);
  }
  say();

  say("Pin changes (repo):");
  if (plan.repoChanges.length === 0) say("  (none)");
  for (const c of plan.repoChanges) {
    say(`  ${c.file.padEnd(36)} ${c.field.padEnd(38)} ${c.from} -> ${c.to}`);
  }
  say("Pin changes (local-packages):");
  if (plan.localChanges.length === 0) say("  (none)");
  for (const c of plan.localChanges) {
    say(`  ${c.file.padEnd(36)} ${c.field.padEnd(38)} ${c.from} -> ${c.to}`);
  }
  say();

  say("Braid version bump:");
  say(`  ${plan.coreVersion.file.padEnd(36)} ${plan.coreVersion.field.padEnd(38)} ${plan.coreVersion.from} -> ${plan.coreVersion.to}`);
  say();

  const drifted = BRAID_PACKAGES.filter((d) => plan.braid[d] && plan.braid[d].installed !== plan.braid[d].repo);
  say(`Installed braid pair (${mark(drifted.length === 0)}):`);
  for (const d of BRAID_PACKAGES) {
    const b = plan.braid[d];
    if (!b) continue;
    say(`  ${b.name.padEnd(24)} installed ${String(b.installed).padEnd(16)} repo ${b.repo}`);
  }
  say();

  say("Publish commands (in order):");
  for (const c of plan.publishCommands) say(`  ${c}`);
  say();
  say(`Runtime command (last${applied ? "" : "; only with --apply --runtime"}):`);
  say(`  ${plan.runtimeCommand}`);
  say();
  say("Rollback:");
  for (const line of rollbackLines(plan.backupDir, plan.runtime, plan.target)) say(`  ${line}`);
}

// --- apply ------------------------------------------------------------------

function stageRollback(plan) {
  const nm = path.join(LOCAL_PACKAGES, "node_modules");
  if (!fs.existsSync(nm)) return { staged: [], dir: plan.backupDir };
  const names = fs.readdirSync(nm).filter((n) => n.startsWith("pi-braid"));
  if (names.length === 0) return { staged: [], dir: plan.backupDir };
  fs.mkdirSync(plan.backupDir, { recursive: true });
  const versions = [];
  for (const name of names) {
    fs.cpSync(path.join(nm, name), path.join(plan.backupDir, name), { recursive: true });
    const v = readJSON(path.join(nm, name, "package.json"))?.version ?? "unknown";
    versions.push(`${name} ${v}`);
  }
  fs.writeFileSync(
    path.join(plan.backupDir, "VERSIONS.txt"),
    [
      "Pre-change versions captured before the update.",
      ...versions,
      `runtime pi ${plan.runtime}`,
      "",
      ...rollbackLines(plan.backupDir, plan.runtime, plan.target),
    ].join("\n") + "\n",
  );
  return { staged: names, dir: plan.backupDir };
}

function bumpCoreVersion(plan) {
  const manifestPath = path.join(REPO_ROOT, plan.coreVersion.file);
  const manifest = readJSON(manifestPath);
  if (!manifest) fail(`cannot read ${manifestPath}`);
  manifest.version = plan.coreVersion.to;
  writeJSON(manifestPath, manifest);
  say(`braid version: ${plan.coreVersion.from} -> ${plan.coreVersion.to} (${plan.coreVersion.file})`);

  // The repo `npm install` has already reconciled the lockfile's resolution
  // (the pi-family entries and their install flags); this line keeps the
  // workspace entry in step with the manifest version without a second install.
  const lockPath = path.join(REPO_ROOT, "package-lock.json");
  const lock = readJSON(lockPath);
  const workspace = `packages/core`;
  if (lock?.packages?.[workspace]) {
    lock.packages[workspace].version = plan.coreVersion.to;
    writeJSON(lockPath, lock);
    say(`lockfile workspace entry ${workspace} -> ${plan.coreVersion.to}`);
  }
}

function applyPlan(plan) {
  const rollback = stageRollback(plan);
  if (rollback.staged.length > 0) {
    say(`rollback staged: ${rollback.dir} (${rollback.staged.join(", ")})`);
  } else {
    say(`rollback: nothing installed under ${path.join(LOCAL_PACKAGES, "node_modules")}`);
  }

  for (const spec of REPO_PIN_SPECS) {
    const { absPath, manifest, rows } = specRows(REPO_ROOT, spec, plan.targets);
    if (!manifest || rows.length === 0) continue;
    for (const row of rows) {
      manifest[spec.field][row.field.slice(spec.field.length + 1)] = row.to;
    }
    writeJSON(absPath, manifest);
  }
  say(`repo pins -> ${plan.target}`);

  // Reconciling the repo is what makes a re-run of `plan` clean: rewriting the
  // pins alone leaves the repo's node_modules and lockfile at the old version.
  say(`aligning repo resolution (${NPM} install)`);
  execFileSync(NPM, ["install"], { cwd: REPO_ROOT, stdio: "inherit" });

  const localManifestPath = path.join(LOCAL_PACKAGES, "package.json");
  const localManifest = readJSON(localManifestPath);
  if (!localManifest) fail(`cannot read ${localManifestPath}`);
  const localDeps = (localManifest.dependencies ??= {});
  for (const name of PI_FAMILY) {
    if (localDeps[name] !== undefined) localDeps[name] = plan.target;
  }
  writeJSON(localManifestPath, localManifest);
  say(`local-packages pins -> ${plan.target}`);

  say(`aligning local-packages (${NPM} install)`);
  execFileSync(NPM, ["install"], { cwd: LOCAL_PACKAGES, stdio: "inherit" });

  bumpCoreVersion(plan);

  const publishScript = path.join(REPO_ROOT, "packages", "core", "scripts", "publish-local.mjs");
  for (const dir of BRAID_PACKAGES) {
    say(`publish: ${dir}`);
    execFileSync(process.execPath, [publishScript, dir], { cwd: REPO_ROOT, stdio: "inherit" });
  }

  say("rollback (staged, not exercised):");
  for (const line of rollbackLines(plan.backupDir, plan.runtime, plan.target)) say(`  ${line}`);

  if (plan.runRuntime) {
    say(`runtime update (last): ${plan.runtimeCommand}`);
    execFileSync(RUNTIME_CMD.bin, RUNTIME_CMD.args, { stdio: "inherit" });
  } else {
    say(`runtime untouched; to move it, re-run with --apply --runtime (${plan.runtimeCommand})`);
  }
}

// --- verify (static half of the smoke checklist) ----------------------------

function entryFiles(pkgDir, manifest) {
  const entries = [];
  if (typeof manifest.main === "string") entries.push(manifest.main);
  const exp = manifest.exports;
  if (typeof exp === "string") entries.push(exp);
  else if (exp && typeof exp === "object") {
    for (const value of Object.values(exp)) {
      if (typeof value === "string") entries.push(value);
      else if (value && typeof value === "object") {
        for (const v of Object.values(value)) if (typeof v === "string") entries.push(v);
      }
    }
  }
  return entries
    .filter((e) => e.startsWith("./") || e.startsWith("../") || /\.(js|cjs|mjs|ts)$/.test(e))
    .map((e) => path.resolve(pkgDir, e));
}

function verify() {
  const target = resolveTarget();
  const runtime = resolveRuntimeVersion();
  const items = [];

  // 1. installed braid packages match the repo manifests
  {
    const problems = [];
    for (const dir of BRAID_PACKAGES) {
      const repoPkg = readJSON(path.join(REPO_ROOT, "packages", dir, "package.json"));
      if (!repoPkg?.name) continue;
      const installed = readJSON(
        path.join(LOCAL_PACKAGES, "node_modules", ...repoPkg.name.split("/"), "package.json"),
      );
      if (!installed) problems.push(`${repoPkg.name}: not installed`);
      else if (installed.version !== repoPkg.version)
        problems.push(`${repoPkg.name}: installed ${installed.version} != repo ${repoPkg.version}`);
    }
    items.push({
      name: "installed braid packages match the repo manifests",
      pass: problems.length === 0,
      evidence: problems.length === 0 ? `${BRAID_PACKAGES.length} packages aligned` : problems.join("; "),
    });
  }

  // 2. repo pins vs installed pins
  {
    const problems = [];
    const manifest = readJSON(path.join(REPO_ROOT, "package.json"));
    for (const name of PI_FAMILY) {
      const pin = manifest?.dependencies?.[name];
      const copy = installedPiVersion(name);
      if (pin === undefined) continue;
      if (pin.replace(/^[\^~]/, "") !== copy)
        problems.push(`${name}: repo pin ${pin} != installed ${copy ?? "not installed"}`);
    }
    items.push({
      name: "repo pins match the installed local-packages copies",
      pass: problems.length === 0,
      evidence: problems.length === 0 ? "pi family aligned" : problems.join("; "),
    });
  }

  // 3. dist / entry files present
  {
    const problems = [];
    let checked = 0;
    for (const dir of BRAID_PACKAGES) {
      const repoPkg = readJSON(path.join(REPO_ROOT, "packages", dir, "package.json"));
      if (!repoPkg?.name) continue;
      const pkgDir = path.join(LOCAL_PACKAGES, "node_modules", ...repoPkg.name.split("/"));
      const installed = readJSON(path.join(pkgDir, "package.json"));
      if (!installed) {
        problems.push(`${repoPkg.name}: not installed`);
        continue;
      }
      for (const entry of entryFiles(pkgDir, installed)) {
        checked++;
        if (!fs.existsSync(entry)) problems.push(`${repoPkg.name}: entry ${path.relative(pkgDir, entry)} missing`);
      }
    }
    items.push({
      name: "dist/entry files present",
      pass: problems.length === 0,
      evidence: problems.length === 0 ? `${checked} entry file(s) present` : problems.join("; "),
    });
  }

  // 4. extension paths named in settings resolve
  {
    const settingsPath = path.join(AGENT_DIR, "settings.json");
    const settings = readJSON(settingsPath);
    const problems = [];
    let checked = 0;
    for (const entry of settings?.packages ?? []) {
      if (typeof entry !== "string" || entry.startsWith("npm:")) continue;
      checked++;
      const resolved = path.resolve(entry.replace(/^~(?=$|\/)/, os.homedir()));
      if (!fs.existsSync(resolved)) problems.push(`${entry}: does not resolve`);
    }
    items.push({
      name: "extension paths named in settings resolve",
      pass: problems.length === 0,
      evidence:
        problems.length === 0
          ? `${checked} path(s) resolve (${settingsPath})`
          : problems.join("; "),
    });
  }

  // 5. installed packages' build-info.json shas recorded
  {
    const problems = [];
    const recorded = [];
    for (const dir of BRAID_PACKAGES) {
      const repoPkg = readJSON(path.join(REPO_ROOT, "packages", dir, "package.json"));
      if (!repoPkg?.name) continue;
      const info = readJSON(
        path.join(LOCAL_PACKAGES, "node_modules", ...repoPkg.name.split("/"), "build-info.json"),
      );
      if (!info) problems.push(`${repoPkg.name}: no build-info.json`);
      else if (!info.sha) problems.push(`${repoPkg.name}: build-info.json carries no sha`);
      else recorded.push(`${repoPkg.name}@${info.version} ${String(info.sha).slice(0, 10)}`);
    }
    items.push({
      name: "installed packages carry a build-info.json sha",
      pass: problems.length === 0,
      evidence: problems.length === 0 ? recorded.join("; ") : problems.join("; "),
    });
  }

  say(`mode: verify (static; reads ${LOCAL_PACKAGES})`);
  say(`target ${target}; runtime pi ${runtime}`);
  say();
  let failed = 0;
  for (const [i, item] of items.entries()) {
    if (!item.pass) failed++;
    say(`${item.pass ? "PASS" : "FAIL"} ${i + 1}. ${item.name}`);
    say(`        ${item.evidence}`);
  }
  say();
  say("Live-session checklist (run in a real session; not automated):");
  for (const line of [
    "braid extensions register and the expected tool surface is present",
    "a timer fires end-to-end and reports drift",
    'delivery exactly once (no "wake fire undelivered", "wake outcome timeout", "permanently undelivered")',
    "no duplicate-instance or load warnings on startup",
    "third-party extensions load (pi-web-access, the herdr pack)",
    "key-ring state file reads without rotation",
  ]) {
    say(`  [ ] ${line}`);
  }
  say();
  if (failed > 0) {
    say(`${failed} static item(s) FAILED`);
    process.exit(1);
  }
  say("all static items pass");
  return 0;
}

// --- dispatch ---------------------------------------------------------------

const flags = process.argv.slice(2);
const known = new Set(["--apply", "--runtime", "--verify", "--yes", "--help"]);
for (const f of flags)
  if (!known.has(f)) fail(`unknown flag "${f}" (expected: --apply | --runtime | --verify | --yes)`);
const wantApply = flags.includes("--apply");
const wantRuntime = flags.includes("--runtime");
const wantVerify = flags.includes("--verify");
const wantYes = flags.includes("--yes");

if (flags.includes("--help")) {
  console.log(
    "update-pipeline.mjs [--apply [--yes]] [--runtime] [--verify]\n" +
      "  (default)  plan, read-only\n" +
      "  --apply    rewrite the repo + local-packages pins, reconcile both resolutions, publish locally (requires --yes)\n" +
      "  --yes      confirm the destructive --apply run\n" +
      "  --runtime  run `pi update` (requires --apply)\n" +
      "  --verify   static half of the smoke checklist (standalone)",
  );
  process.exit(0);
}

if (wantVerify && (wantApply || wantRuntime)) {
  fail("--verify is a standalone read-only mode; it cannot be combined with --apply/--runtime");
}
// The refusals are checked before anything else runs, so no shimmed `pi` and no
// npm call can be reached by an unrelated flag combination.
if (wantRuntime && !wantApply) {
  fail("--runtime requires --apply (the runtime update is the last step of a real run)");
}
// The confirmation gate. Every destructive step (the repo + local-packages
// installs, the manifest rewrites, the five publishes, the rollback staging) is
// reached only from applyPlan below, so this refusal makes them unreachable
// without --yes.
if (wantApply && !wantYes) {
  fail(
    "--apply rewrites the repo pins, runs npm install in the repo and in local-packages, bumps the braid version, publishes all five braid packages, and stages a rollback directory; re-run with --apply --yes to confirm, or use the default plan for the dry run",
  );
}

if (wantVerify) process.exit(verify());

const plan = buildPlan();
plan.runRuntime = wantRuntime;

if (!wantApply) {
  printPlan(plan);
  process.exit(0);
}

printPlan(plan, { applied: true });
say();
applyPlan(plan);

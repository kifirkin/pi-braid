/**
 * test-update-pipeline-plan.mjs -- the update pipeline's contract, held by
 * fixtures only.
 *
 * Every case drives scripts/update-pipeline.mjs against a temporary tree: a
 * fake repo, a fake local-packages, a fake agent dir, and a temp HOME. No
 * fixture ever touches the live repo, the live ~/.pi/agent/local-packages, or
 * the network (the target version is supplied through the env hook, so the
 * `npm view` path is not taken).
 *
 * A shim `pi` early on PATH records any invocation: the pipeline may never
 * launch a pi process in plan, verify, or apply (only `--apply --runtime`
 * would, and that combination is never run here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "update-pipeline.mjs");

const TARGET = "0.87.1";
const BRAID_PACKAGES = ["core", "providers", "skills", "telegram", "contrib"];
const BRAID_NAMES = {
  core: "pi-braid",
  providers: "pi-braid-providers",
  skills: "pi-braid-skills",
  telegram: "pi-braid-telegram",
  contrib: "pi-braid-contrib",
};
const BRAID_VERSIONS = {
  core: "0.3.2-main.20",
  providers: "1.0.4-main.2",
  skills: "0.2.0-main.1",
  telegram: "0.1.4-main.4",
  contrib: "0.1.0-main.1",
};

function writeJSON(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function script(p, body) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

/**
 * A repo + local-packages tree at a chosen drift point. repoPin is what the
 * repo manifests declare; installedPi is what the local-packages copies
 * actually resolve.
 */
function buildFixture({ repoPin = "0.85.1", installedPi = "0.85.1" } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "update-pipeline-test-"));
  const repo = join(sandbox, "repo");
  const lp = join(sandbox, "local-packages");
  const agent = join(sandbox, "agent");
  const home = join(sandbox, "home");
  const logs = join(sandbox, "logs");
  const bin = join(sandbox, "bin");
  for (const d of [repo, lp, agent, home, logs, bin]) mkdirSync(d, { recursive: true });

  // --- repo ---
  writeJSON(join(repo, "package.json"), {
    name: "fixture-root",
    version: "0.0.0",
    private: true,
    workspaces: BRAID_PACKAGES.map((d) => `packages/${d}`),
    dependencies: {
      "@earendil-works/pi-agent-core": repoPin,
      "@earendil-works/pi-ai": repoPin,
      "@earendil-works/pi-coding-agent": repoPin,
    },
  });
  writeJSON(join(repo, "package-lock.json"), {
    name: "fixture-root",
    lockfileVersion: 3,
    packages: { "": { version: "0.0.0" }, "packages/core": { version: BRAID_VERSIONS.core } },
  });
  writeJSON(join(repo, "packages", "core", "package.json"), {
    name: BRAID_NAMES.core,
    version: BRAID_VERSIONS.core,
    main: "./dist/index.js",
    files: ["dist/**/*.js"],
  });
  writeJSON(join(repo, "packages", "providers", "package.json"), {
    name: BRAID_NAMES.providers,
    version: BRAID_VERSIONS.providers,
    devDependencies: { "@earendil-works/pi-ai": `^${repoPin}` },
    peerDependencies: {
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
    },
  });
  for (const dir of ["skills", "telegram", "contrib"]) {
    writeJSON(join(repo, "packages", dir, "package.json"), {
      name: BRAID_NAMES[dir],
      version: BRAID_VERSIONS[dir],
      files: ["README.md"],
    });
  }
  // The repo's own resolved copies. Rewriting the pins must move these too, or
  // a re-plan after apply still reports repo drift.
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
    writeJSON(join(repo, "node_modules", "@earendil-works", name, "package.json"), {
      name: `@earendil-works/${name}`,
      version: repoPin,
    });
  }
  // The publish step composes this script; the fixture replaces it with a
  // recorder so apply never runs a real pack or install.
  script(
    join(repo, "packages", "core", "scripts", "publish-local.mjs"),
    '#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\n' +
      'appendFileSync(process.env.PUBLISH_STUB_LOG, (process.argv[2] ?? "") + "\\n");\n',
  );

  // --- local-packages ---
  writeJSON(join(lp, "package.json"), {
    name: "local-packages",
    version: "1.0.0",
    private: true,
    dependencies: {
      "@earendil-works/pi-agent-core": installedPi,
      "@earendil-works/pi-ai": installedPi,
      "@earendil-works/pi-coding-agent": installedPi,
      [BRAID_NAMES.core]: `file:${BRAID_NAMES.core}-${BRAID_VERSIONS.core}.tgz`,
    },
  });
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
    writeJSON(join(lp, "node_modules", "@earendil-works", name, "package.json"), {
      name: `@earendil-works/${name}`,
      version: installedPi,
    });
  }
  for (const dir of BRAID_PACKAGES) {
    const name = BRAID_NAMES[dir];
    const pkgDir = join(lp, "node_modules", name);
    writeJSON(join(pkgDir, "package.json"), {
      name,
      version: BRAID_VERSIONS[dir],
      ...(dir === "core" ? { main: "./dist/index.js" } : {}),
    });
    writeJSON(join(pkgDir, "build-info.json"), {
      name,
      version: BRAID_VERSIONS[dir],
      sha: `fixture-sha-${dir}`,
      shaShort: "fixturesh",
      branch: "main",
      dirty: false,
      packedAt: "2026-01-01T00:00:00.000Z",
    });
    if (dir === "core") {
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(join(pkgDir, "dist", "index.js"), "// fixture entry\n");
    }
  }

  // --- agent dir ---
  writeJSON(join(agent, "settings.json"), {
    packages: [
      join(lp, "node_modules", BRAID_NAMES.core),
      join(lp, "node_modules", BRAID_NAMES.skills),
      "npm:pi-web-access",
    ],
  });

  // --- stubs ---
  // The npm stand-in logs every call and, on `install`, mirrors what npm does
  // to the resolution: it moves the pi-family copies under the cwd's
  // node_modules to the target version. That is what makes a post-apply re-plan
  // observable on a fixture (real npm also rewrites the lockfile).
  const npmStub = join(bin, "npm-stub.mjs");
  script(
    npmStub,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'appendFileSync(process.env.NPM_STUB_LOG, `${process.argv.slice(2).join(" ")} @ ${process.cwd()}\\n`);',
      'if (process.argv[2] === "install") {',
      "  const target = process.env.UPDATE_TARGET_VERSION;",
      '  const nm = join(process.cwd(), "node_modules", "@earendil-works");',
      '  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {',
      '    const manifest = join(nm, name, "package.json");',
      "    if (!existsSync(manifest)) continue;",
      '    const obj = JSON.parse(readFileSync(manifest, "utf8"));',
      "    obj.version = target;",
      '    writeFileSync(manifest, JSON.stringify(obj, null, 2) + "\\n");',
      "  }",
      "}",
      "process.exit(0);",
    ].join("\n") + "\n",
  );
  const piShim = join(bin, "pi");
  script(piShim, '#!/bin/sh\necho "pi $@" >> "$PI_SHIM_LOG"\nexit 1\n');

  return {
    sandbox,
    repo,
    lp,
    agent,
    home,
    logs,
    bin,
    npmStub,
    publishLog: join(logs, "publish.log"),
    npmLog: join(logs, "npm.log"),
    piLog: join(logs, "pi.log"),
  };
}

function envFor(fx, extra = {}) {
  return {
    ...process.env,
    HOME: fx.home,
    UPDATE_REPO_ROOT: fx.repo,
    LOCAL_PKG: fx.lp,
    PI_CODING_AGENT_DIR: fx.agent,
    UPDATE_TARGET_VERSION: TARGET,
    UPDATE_RUNTIME_VERSION: "0.85.1",
    UPDATE_NPM: fx.npmStub,
    PUBLISH_STUB_LOG: fx.publishLog,
    NPM_STUB_LOG: fx.npmLog,
    PI_SHIM_LOG: fx.piLog,
    // The shim sits first so any `pi` exec would be recorded, not run.
    PATH: `${fx.bin}:${process.env.PATH}`,
    ...extra,
  };
}

function runPipeline(fx, args = []) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd: fx.sandbox,
    env: envFor(fx),
    encoding: "utf8",
    timeout: 25_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function digest(root) {
  const lines = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const child = join(dir, e.name);
      if (e.isDirectory()) walk(child, childRel);
      else if (e.isFile())
        lines.push(`${childRel} ${createHash("sha256").update(readFileSync(child)).digest("hex")}`);
    }
  };
  walk(root, "");
  return lines.join("\n");
}

function treeDigest(fx) {
  return [fx.repo, fx.lp, fx.agent, fx.home].map(digest).join("\n--\n");
}

function output(res) {
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

/** The live files an apply must never touch, captured for a before/after check. */
function liveSentinel() {
  const paths = [
    join(ROOT, "package.json"),
    join(homedir(), ".pi", "agent", "local-packages", "package.json"),
  ];
  return paths.map((p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "missing")).join("|");
}

test("plan lists the pin changes and writes nothing", () => {
  const fx = buildFixture({ repoPin: "0.85.1", installedPi: "0.85.1" });
  try {
    const before = treeDigest(fx);
    const res = runPipeline(fx);
    assert.equal(res.status, 0, `plan must exit 0: ${output(res)}`);
    const out = output(res);
    assert.match(out, /Pin changes \(repo\):/, "plan must name the repo pin changes");
    assert.match(
      out,
      /package\.json\s+dependencies\.@earendil-works\/pi-ai\s+0\.85\.1 -> 0\.87\.1/,
      "plan must show the repo pin from -> to",
    );
    assert.match(
      out,
      /packages\/providers\/package\.json\s+devDependencies\.@earendil-works\/pi-ai\s+\^0\.85\.1 -> \^0\.87\.1/,
      "plan must show the providers devDependency change",
    );
    assert.match(out, /Pin changes \(local-packages\):/, "plan must name the local-packages changes");
    assert.match(
      out,
      /Braid version bump:[\s\S]*0\.3\.2-main\.20 -> 0\.3\.2-main\.21/,
      "plan must show the braid version bump",
    );
    assert.match(out, /publish-local\.mjs core/, "plan must name the publish commands");
    assert.match(out, /pi update/, "plan must name the runtime command");
    assert.match(out, /Rollback:/, "plan must print the rollback commands");
    assert.equal(treeDigest(fx), before, "plan mode must not write to the tree");
    assert.ok(!existsSync(fx.piLog), "plan must never launch pi");
  } finally {
    rmSync(fx.sandbox, { recursive: true, force: true });
  }
});

test("apply rewrites only the fixture and stages the rollback directory", () => {
  const fx = buildFixture({ repoPin: "0.85.1", installedPi: "0.85.1" });
  const liveBefore = liveSentinel();
  try {
    const res = runPipeline(fx, ["--apply", "--yes"]);
    assert.equal(res.status, 0, `apply must exit 0: ${output(res)}`);

    const root = JSON.parse(readFileSync(join(fx.repo, "package.json"), "utf8"));
    for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
      assert.equal(root.dependencies[`@earendil-works/${name}`], TARGET, `repo pin ${name} must move`);
    }
    const providers = JSON.parse(readFileSync(join(fx.repo, "packages", "providers", "package.json"), "utf8"));
    assert.equal(providers.devDependencies["@earendil-works/pi-ai"], `^${TARGET}`, "providers range must move");

    const core = JSON.parse(readFileSync(join(fx.repo, "packages", "core", "package.json"), "utf8"));
    assert.equal(core.version, "0.3.2-main.21", "the braid version must be bumped");
    const lock = JSON.parse(readFileSync(join(fx.repo, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["packages/core"].version, "0.3.2-main.21", "the lockfile workspace entry must follow");

    const lp = JSON.parse(readFileSync(join(fx.lp, "package.json"), "utf8"));
    for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
      assert.equal(lp.dependencies[`@earendil-works/${name}`], TARGET, `local-packages pin ${name} must move`);
    }

    const backups = readdirSync(fx.lp).filter((n) => n.startsWith("backup-"));
    assert.equal(backups.length, 1, "exactly one rollback directory must be staged");
    const backupDir = join(fx.lp, backups[0]);
    assert.ok(existsSync(join(backupDir, BRAID_NAMES.core, "package.json")), "the installed packages must be captured");
    const versions = readFileSync(join(backupDir, "VERSIONS.txt"), "utf8");
    assert.match(versions, /pi-braid 0\.3\.2-main\.20/, "VERSIONS.txt must record the pre-change version");

    const published = readFileSync(fx.publishLog, "utf8").trim().split("\n");
    assert.deepEqual(published, BRAID_PACKAGES, "every braid package must be published, in order");
    assert.match(readFileSync(fx.npmLog, "utf8"), /install/, "the local-packages pin alignment must install");

    assert.equal(liveSentinel(), liveBefore, "apply must not touch the live repo or the live local-packages");
    assert.ok(!existsSync(fx.piLog), "apply without --runtime must never launch pi");
  } finally {
    rmSync(fx.sandbox, { recursive: true, force: true });
  }
});

test("apply reconciles the repo resolution so a re-plan reports no drift", () => {
  const fx = buildFixture({ repoPin: "0.85.1", installedPi: "0.85.1" });
  try {
    const applied = runPipeline(fx, ["--apply", "--yes"]);
    assert.equal(applied.status, 0, `apply must exit 0: ${output(applied)}`);

    const repoCopies = ["pi-agent-core", "pi-ai", "pi-coding-agent"].map(
      (name) =>
        JSON.parse(
          readFileSync(join(fx.repo, "node_modules", "@earendil-works", name, "package.json"), "utf8"),
        ).version,
    );
    assert.deepEqual(repoCopies, [TARGET, TARGET, TARGET], "the repo's resolved copies must move to the target");

    const npmLines = readFileSync(fx.npmLog, "utf8").trim().split("\n");
    assert.ok(
      npmLines.includes(`install @ ${realpathSync(fx.repo)}`),
      "apply must run npm install at the repo root",
    );
    assert.ok(
      npmLines.includes(`install @ ${realpathSync(fx.lp)}`),
      "apply must run npm install in local-packages",
    );

    const replan = runPipeline(fx);
    assert.equal(replan.status, 0, `re-plan must exit 0: ${output(replan)}`);
    assert.match(output(replan), /repo resolution \(ok\)/, "a re-plan after apply must report repo resolution ok");
    assert.doesNotMatch(output(replan), /repo resolution \(DRIFT\)/, "no repo drift may survive apply");
  } finally {
    rmSync(fx.sandbox, { recursive: true, force: true });
  }
});

test("apply without --yes is refused before anything runs", () => {
  const fx = buildFixture();
  try {
    for (const args of [["--apply"], ["--apply", "--runtime"]]) {
      const res = runPipeline(fx, args);
      assert.notEqual(res.status, 0, `apply without --yes must be refused: ${args.join(" ")}`);
      const out = output(res);
      assert.match(out, /--yes/, "the refusal must name the missing confirmation flag");
      assert.match(out, /publishes/, "the refusal must name what would have happened");
    }
    assert.ok(!existsSync(fx.npmLog), "a refused apply must not install anything");
    assert.ok(!existsSync(fx.publishLog), "a refused apply must not publish anything");
    assert.ok(!existsSync(fx.piLog), "a refused apply must never launch pi");
    assert.equal(
      readdirSync(fx.lp).filter((n) => n.startsWith("backup-")).length,
      0,
      "a refused apply must not stage a rollback",
    );
  } finally {
    rmSync(fx.sandbox, { recursive: true, force: true });
  }
});

test("verify fails on a misaligned fixture and passes on an aligned one", () => {
  const bad = buildFixture({ repoPin: "0.85.1", installedPi: TARGET });
  try {
    const res = runPipeline(bad, ["--verify"]);
    assert.notEqual(res.status, 0, "--verify must exit non-zero on a misaligned pair");
    assert.match(
      output(res),
      /repo pin 0\.85\.1 != installed 0\.87\.1/,
      "the failure must name the exact misalignment",
    );
  } finally {
    rmSync(bad.sandbox, { recursive: true, force: true });
  }

  const good = buildFixture({ repoPin: TARGET, installedPi: TARGET });
  try {
    const res = runPipeline(good, ["--verify"]);
    assert.equal(res.status, 0, `--verify must pass on an aligned pair: ${output(res)}`);
    assert.match(output(res), /all static items pass/);
    assert.match(output(res), /Live-session checklist/, "the manual checklist must still be printed");
  } finally {
    rmSync(good.sandbox, { recursive: true, force: true });
  }
});

test("--runtime without --apply is refused before anything runs", () => {
  const fx = buildFixture();
  try {
    const res = runPipeline(fx, ["--runtime"]);
    assert.notEqual(res.status, 0, "--runtime alone must be refused");
    assert.match(output(res), /--runtime requires --apply/, "the refusal must name the missing flag");
    assert.ok(!existsSync(fx.npmLog), "a refused run must not install anything");
    assert.ok(!existsSync(fx.publishLog), "a refused run must not publish anything");
    assert.ok(!existsSync(fx.piLog), "a refused run must never launch pi");
  } finally {
    rmSync(fx.sandbox, { recursive: true, force: true });
  }
});

test("no mode ever launches a pi process", () => {
  const fx = buildFixture({ repoPin: "0.85.1", installedPi: "0.85.1" });
  try {
    for (const args of [[], ["--verify"], ["--runtime"], ["--apply", "--yes"]]) {
      runPipeline(fx, args);
    }
    assert.ok(!existsSync(fx.piLog), "no mode may invoke the pi binary");
  } finally {
    rmSync(fx.sandbox, { recursive: true, force: true });
  }
});

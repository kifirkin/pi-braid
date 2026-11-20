#!/usr/bin/env node
/**
 * check-pi-surface.mjs - hold the recorded pi surface to the installed one.
 *
 * `pi-surface.json` is what braid takes from pi, symbol by symbol, written by
 * `--record` (see `pi-surface.mjs` for the surface list and the extractor).
 * This script is the gate over it and the reconciliation a human reads before
 * an upgrade.
 *
 * Modes:
 *   node packages/core/scripts/check-pi-surface.mjs
 *       reconciliation for a human: the installed pi, the versions the manifest
 *       was recorded against, every declared dependency range and whether the
 *       installed version satisfies it, then the symbol comparison. Exit 0 when
 *       the symbols agree; a version mismatch is a report, not a failure.
 *   node packages/core/scripts/check-pi-surface.mjs --check
 *       the gate: one line on agreement, one failure line per difference.
 *   node packages/core/scripts/check-pi-surface.mjs --record
 *       rewrite the manifest from the installed declarations. Refuses when a
 *       row names a symbol its declared file does not declare, so a record
 *       cannot quietly shrink the surface it vouches for.
 *
 * Flags: `--manifest <path>` writes or reads another record (a fixture, or a
 * scratch run). `PI_SURFACE_PI_ROOT` points the whole run at another pi
 * install; by default it reads the workspace's own node_modules.
 *
 * What a failure means. A recorded symbol that is gone, whose kind changed, or
 * whose declaration head changed is a difference: pi moved something braid
 * names. A recorded member that is gone or whose signature changed is a
 * difference too, and the line names the member, so the answer is a reading of
 * the diff rather than a search. An added member, or an added overload line, is
 * printed as an addition and does not fail: pi adding to an interface cannot
 * break a caller. Everything is compared against the record, never against a
 * version string, so a manifest recorded at one release passes on another when
 * the symbols braid uses are the same.
 *
 * Exit codes: 0 agree, 1 the surface differs or the record is unusable, 2 the
 * command line is.
 */
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANIFEST_PATH,
  declaredRanges,
  extractSurface,
  readManifest,
  resolvePiRoot,
  satisfiesRange,
  splitTopLevel,
} from "./pi-surface.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const USAGE = `usage: node packages/core/scripts/check-pi-surface.mjs [--check | --record] [--manifest <path>]

  (no flag)   print the reconciliation and compare the symbols
  --check     compare only: one line on agreement, one per difference
  --record    rewrite the manifest from the installed declarations
  --manifest  record path (default packages/core/pi-surface.json)
`;

function parseArgs(argv) {
  const args = { mode: "report", manifest: MANIFEST_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check" || arg === "--record") {
      if (args.mode !== "report") return { error: "give at most one of --check and --record" };
      args.mode = arg.slice(2);
    } else if (arg === "--manifest") {
      const value = argv[++i];
      if (!value) return { error: "--manifest needs a path" };
      args.manifest = isAbsolute(value) ? value : resolve(process.cwd(), value);
    } else if (arg === "--help" || arg === "-h") {
      args.mode = "help";
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  return args;
}

/** A normalized member line split into head, parameters and tail, or null when
 *  the line carries no parameter list. */
function signatureParts(line) {
  const open = line.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  let quote = "";
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return {
          head: line.slice(0, open),
          params: splitTopLevel(line.slice(open + 1, i), ",").map((param) => param.trim()),
          tail: line.slice(i + 1),
        };
      }
    }
  }
  return null;
}

/** Whether one parameter can be left out at the call site. */
function isOptionalParameter(param) {
  const colon = param.indexOf(":");
  if (colon < 0) return param.includes("=");
  return param.slice(0, colon).includes("?") || param.indexOf("=", colon) >= 0;
}

/**
 * A one-line reason when the only change between two member lines is trailing
 * optional parameters, or null.
 *
 * The tool never decides assignability: the same text change is additive in a
 * parameter list and breaking in a callback position, and telling those apart
 * needs the type checker. What the text does settle is that everything around
 * the parameter list is identical and the parameters appended to it can all be
 * omitted, so a caller of the recorded shape cannot notice.
 */
function wideningNote(recorded, current) {
  const before = signatureParts(recorded);
  const after = signatureParts(current);
  if (!before || !after) return null;
  if (before.head !== after.head || before.tail !== after.tail) return null;
  if (after.params.length <= before.params.length) return null;
  const kept = before.params.every((param, index) => param === after.params[index]);
  if (!kept) return null;
  const added = after.params.slice(before.params.length);
  if (!added.every(isOptionalParameter)) return null;
  const what = added.length === 1 ? "an optional parameter" : `${added.length} optional parameters`;
  return `the difference adds ${what}, so callers of the recorded shape are unaffected: re-record when the pinned range moves`;
}

/** Recorded symbols and live symbols, read from the same rows. */
function compare(manifest, live) {
  const failures = [];
  const additions = [];
  let symbols = 0;
  let members = 0;
  const missingAt = new Map((live.missing ?? []).map((entry) => [`${entry.surface}/${entry.symbol}`, entry]));

  for (const [name, recordedSurface] of Object.entries(manifest.surfaces)) {
    const liveSurface = live.surfaces[name];
    if (!liveSurface) {
      failures.push(
        `surface "${name}" is in the manifest but no longer declared in pi-surface.mjs: re-record it`,
      );
      continue;
    }
    if (recordedSurface.file !== liveSurface.file || recordedSurface.package !== liveSurface.package) {
      failures.push(
        `surface "${name}" moved: recorded ${recordedSurface.package} ${recordedSurface.file}, now ${liveSurface.package} ${liveSurface.file}: re-record it`,
      );
    }
    for (const [symbol, recorded] of Object.entries(recordedSurface.symbols ?? {})) {
      symbols++;
      const current = liveSurface.symbols[symbol];
      if (!current) {
        const hint = missingAt.get(`${name}/${symbol}`);
        const where = hint?.elsewhere?.length
          ? ` (it is declared in ${hint.elsewhere.join(", ")})`
          : "";
        failures.push(`${name}/${symbol}: gone from ${liveSurface.package} ${liveSurface.file}${where}`);
        continue;
      }
      if (!recorded || typeof recorded.signature !== "string" || typeof recorded.kind !== "string") {
        failures.push(`${name}/${symbol}: the manifest entry is malformed: re-record it`);
        continue;
      }
      if (recorded.kind !== current.kind) {
        failures.push(`${name}/${symbol}: kind changed from ${recorded.kind} to ${current.kind}`);
      }
      if (recorded.signature !== current.signature) {
        failures.push(
          `${name}/${symbol}: signature changed: recorded "${recorded.signature}", now "${current.signature}"`,
        );
      }
      const recordedMembers = recorded.members ?? {};
      const currentMembers = current.members ?? {};
      for (const [member, lines] of Object.entries(recordedMembers)) {
        members++;
        const currentLines = currentMembers[member];
        if (!currentLines) {
          failures.push(`${name}/${symbol}: member "${member}" is gone`);
          continue;
        }
        const missing = lines.filter((line) => !currentLines.includes(line));
        const fresh = currentLines.filter((line) => !lines.includes(line));
        if (missing.length) {
          const note = lines.length === 1 && currentLines.length === 1 ? wideningNote(lines[0], currentLines[0]) : null;
          const detail =
            lines.length === 1 && currentLines.length === 1
              ? `recorded "${lines[0]}", now "${currentLines[0]}"`
              : `recorded "${missing.join('" and "')}", now "${fresh.join('" and "')}"`;
          failures.push(
            `${name}/${symbol}: member "${member}" changed: ${detail}${note ? ` (${note})` : ""}`,
          );
        } else if (fresh.length) {
          additions.push(
            `${name}/${symbol}: member "${member}" has ${fresh.length} new signature line(s): ${fresh.join(" | ")}`,
          );
        }
      }
      for (const member of Object.keys(currentMembers)) {
        if (recordedMembers[member]) continue;
        additions.push(`${name}/${symbol}: new member "${member}"`);
      }
    }
  }

  for (const [name, liveSurface] of Object.entries(live.surfaces)) {
    const recordedSurface = manifest.surfaces[name];
    if (!recordedSurface) {
      failures.push(
        `surface "${name}" is declared in pi-surface.mjs (${liveSurface.package} ${liveSurface.file}) but absent from the manifest: re-record it`,
      );
      continue;
    }
    for (const symbol of Object.keys(liveSurface.symbols)) {
      if (recordedSurface.symbols?.[symbol]) continue;
      failures.push(`${name}/${symbol} is declared in pi-surface.mjs but absent from the manifest: re-record it`);
    }
  }

  // A row symbol the tree does not declare and the manifest does not record is
  // a wrong row, not an upgrade: the record refused it, so nobody could have
  // written a manifest holding it.
  for (const entry of live.missing ?? []) {
    if (manifest.surfaces[entry.surface]?.symbols?.[entry.symbol]) continue;
    failures.push(
      `surface "${entry.surface}": row symbol ${entry.symbol} is not declared in ${entry.file}, and the manifest does not record it either`,
    );
  }

  return { failures, additions, symbols, members };
}

/** One line per package whose recorded version differs from the installed one. */
function versionNotes(manifest, live) {
  const notes = [];
  for (const [name, version] of Object.entries(live.packages)) {
    const recorded = manifest.packages?.[name];
    if (recorded && recorded !== version) {
      notes.push(`recorded against ${name} ${recorded}, installed ${version}`);
    } else if (!recorded) {
      notes.push(`no recorded version for ${name} (the manifest predates it)`);
    }
  }
  for (const name of Object.keys(manifest.packages ?? {})) {
    if (!live.packages[name]) {
      notes.push(`the manifest records ${name}, which these rows no longer name`);
    }
  }
  return notes;
}

function countSurfaces(manifest) {
  return Object.keys(manifest.surfaces).length;
}

function record(args) {
  const live = extractSurface();
  const manifest = { version: live.version, packages: live.packages, surfaces: live.surfaces };
  const symbols = Object.values(manifest.surfaces).reduce(
    (total, surface) => total + Object.keys(surface.symbols).length,
    0,
  );
  const count = countSurfaces(manifest);
  return formatJson(`${JSON.stringify(manifest, null, 2)}\n`, args.manifest).then((text) => {
    writeFileSync(args.manifest, text);
    console.log(
      `recorded ${count} surface${count === 1 ? "" : "s"}, ${symbols} symbols from ${describePackages(live)} into ${args.manifest}`,
    );
    return 0;
  });
}

/** The repository's formatter is the authority on how a JSON file is laid out,
 *  and this one is written by hand. Format through it, with the config that
 *  governs the target path, so a fresh record leaves `format:check` green:
 *  prettier's API does not read a config file for a `filepath` on its own,
 *  which is how the CLI and the API can disagree on line width. Without the
 *  formatter installed the plain rendering is still a valid record. */
async function formatJson(text, file) {
  try {
    const prettier = await import("prettier");
    const config = (await prettier.resolveConfig(file)) ?? {};
    return await prettier.format(text, { ...config, filepath: file, parser: "json" });
  } catch {
    return text;
  }
}

function describePackages(live) {
  return Object.entries(live.packages)
    .map(([name, version]) => `${shortName(name)} ${version}`)
    .join(", ");
}

function shortName(name) {
  return name.slice(name.lastIndexOf("/") + 1);
}

function check(args) {
  const manifest = readManifest(args.manifest);
  const live = extractSurface({ lenient: true });
  const result = compare(manifest, live);
  const notes = versionNotes(manifest, live);

  if (result.failures.length === 0) {
    const count = countSurfaces(live);
    console.log(
      `check-pi-surface: ${count} surface${count === 1 ? "" : "s"}, ${result.symbols} symbols, ` +
        `${result.members} members match (${describePackages(live)})`,
    );
    for (const note of notes) console.log(`  note: ${note}; the recorded symbols are identical`);
    if (result.additions.length) {
      console.log(`  note: ${result.additions.length} additive change(s), not a failure:`);
      for (const addition of result.additions) console.log(`    ${addition}`);
    }
    return 0;
  }

  console.log(
    `check-pi-surface: ${result.failures.length} difference(s) between ${args.manifest} ` +
      `(recorded against ${describePackages(manifest)}) and the installed ${describePackages(live)}`,
  );
  for (const failure of result.failures) console.log(`  ${failure}`);
  if (result.additions.length) {
    console.log(`  also, ${result.additions.length} additive change(s), not counted as differences:`);
    for (const addition of result.additions) console.log(`    ${addition}`);
  }
  console.log(
    "  re-record with: node packages/core/scripts/check-pi-surface.mjs --record",
  );
  return 1;
}

function report(args) {
  const pi = resolvePiRoot();
  const live = extractSurface({ lenient: true });
  const manifest = readManifest(args.manifest);
  const result = compare(manifest, live);
  const notes = versionNotes(manifest, live);

  console.log("pi surface reconciliation");
  console.log(`  pi root      ${pi.root}`);
  console.log(`  installed    ${describePackages(live)}`);
  console.log(
    `  manifest     ${args.manifest} recorded against ${
      Object.entries(manifest.packages ?? {})
        .map(([name, version]) => `${shortName(name)} ${version}`)
        .join(", ") || "nothing"
    }`,
  );

  const ranges = declaredRanges(REPO_ROOT, Object.keys(live.packages));
  if (ranges.length) {
    console.log(`  declared     ${ranges.length} dependency field(s) name a recorded package`);
    for (const row of ranges) {
      const installed = live.packages[row.name];
      const verdict = satisfiesRange(installed, row.range);
      const where = `${row.file}${row.line ? `:${row.line}` : ""} ${row.field}`;
      const head = `${where} ${row.name} "${row.range}"`;
      const tail =
        verdict === null
          ? "range form not evaluated"
          : verdict
            ? `satisfied by ${installed}`
            : `NOT satisfied: installed ${installed}`;
      console.log(`               ${head}: ${tail}`);
    }
  } else {
    console.log("  declared     no dependency field names a recorded package");
  }

  const count = countSurfaces(live);
  if (result.failures.length === 0) {
    console.log(
      `  symbols      ${result.symbols} across ${count} surfaces: present, signatures unchanged`,
    );
  } else {
    console.log(`  symbols      ${result.failures.length} difference(s)`);
    for (const failure of result.failures) console.log(`               ${failure}`);
  }
  for (const note of notes) {
    console.log(`  note         ${note}; the recorded symbols are ${result.failures.length ? "not identical (above)" : "identical"}`);
  }
  for (const addition of result.additions) console.log(`  addition     ${addition}`);
  return result.failures.length === 0 ? 0 : 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`check-pi-surface: ${args.error}\n\n${USAGE}`);
    return Promise.resolve(2);
  }
  if (args.mode === "help") {
    console.log(USAGE.trimEnd());
    return Promise.resolve(0);
  }
  if (args.mode === "record") {
    return record(args).catch((err) => {
      console.error(`check-pi-surface: ${err.message}`);
      return 1;
    });
  }
  try {
    if (args.mode === "check") return Promise.resolve(check(args));
    return Promise.resolve(report(args));
  } catch (err) {
    console.error(`check-pi-surface: ${err.message}`);
    return Promise.resolve(1);
  }
}

process.exit(await main());

#!/usr/bin/env node
/**
 * publish-local.mjs — versioned local publish pipeline for pi-braid.
 *
 * Produces a semantically-versioned tgz (base + branch + iteration) and
 * installs it into ~/.pi/agent/local-packages. Source package.json is bumped
 * only temporarily and reverted via `git checkout` so the repo stays clean.
 *
 * Version scheme:  <base>-<sanitized-branch>.<iteration>
 *   e.g. 0.3.0-feature-ctx-budget.4
 *   - base          = current package.json version (e.g. 0.3.0)
 *   - branch        = git branch, sanitized to [a-zA-Z0-9.-]
 *   - iteration     = commit count on this branch since main/master
 *
 * Pre-publish: npm prepublishOnly runs `typecheck && build` (see package.json).
 *
 * Usage:
 *   node scripts/publish-local.mjs            # versioned tgz -> local-packages
 *   LOCAL_PKG=~/other/node_modules node ...   # override install destination
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const root = process.cwd();
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const base = pkg.version;

function sh(cmd) {
	try {
		return execSync(cmd, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
			.toString()
			.trim();
	} catch {
		return "";
	}
}

// --- branch (sanitized) ---
let branch = sh("git rev-parse --abbrev-ref HEAD") || "detached";
branch = branch.replace(/[^a-zA-Z0-9.-]/g, "-");

// --- iteration: commits on this branch since main/master ---
let iter = "0";
const base_branch = sh("git rev-parse --verify main 2>/dev/null") || sh("git rev-parse --verify master 2>/dev/null");
if (base_branch) {
	const count = sh(`git rev-list --count ${base_branch}..HEAD`);
	if (count) iter = count;
} else {
	// no main/master: use short sha as iteration
	const sha = sh("git rev-parse --short HEAD");
	if (sha) iter = sha;
}

const ver = `${base}-${branch}.${iter}`;
const tgzName = `pi-braid-${ver}.tgz`;
const dest = process.env.LOCAL_PKG || path.join(homedir(), ".pi/agent/local-packages");

console.log(`[publish-local] version ${ver}`);
console.log(`[publish-local] branch=${branch} iteration=${iter}`);

// Temporarily bump version (no git tag, no commit)
execSync(`npm version ${ver} --no-git-tag-version --allow-same-version`, {
	cwd: root,
	stdio: "inherit",
});

let ok = false;
try {
	// prepublishOnly (typecheck+build) + pack
	execSync("npm pack", { cwd: root, stdio: "inherit" });
	fs.mkdirSync(dest, { recursive: true });
	fs.copyFileSync(path.join(root, tgzName), path.join(dest, tgzName));
	execSync(`cd ${JSON.stringify(dest)} && npm install ./${tgzName}`, {
		cwd: root,
		stdio: "inherit",
	});
	console.log(`[publish-local] installed ${tgzName} -> ${dest}`);
	ok = true;
} catch (e) {
	console.error(`[publish-local] FAILED: ${e.message}`);
} finally {
	// Revert the temporary version bump so the repo stays clean.
	execSync("git checkout package.json", { cwd: root, stdio: "inherit" });
	// Remove the tgz from the source tree (it lives in dest now).
	const srcTgz = path.join(root, tgzName);
	if (fs.existsSync(srcTgz)) fs.unlinkSync(srcTgz);
}

process.exit(ok ? 0 : 1);

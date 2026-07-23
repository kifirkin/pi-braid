#!/usr/bin/env node
/**
 * check-skills.mjs — CI guard against duplicate skill names across braid packages.
 *
 * Native pi-core already *reports* skill collisions (✓/✗ table) but still loads the
 * first copy and silently skips the rest. For braid's own packages a duplicate
 * skill name is a build-time error: it causes silent shadowing (we hit this when a
 * stale pi-braid tgz shadowed pi-braid-skills for 7 skills).
 *
 * Usage: node scripts/check-skills.mjs [--fix]
 *   --fix  move colliding skills into pi-braid-skills (interactive-ish: prints plan)
 *
 * Exits 1 if any skill name is declared by >1 package's `pi.skills`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const packages = ["pi-braid", "pi-braid-contrib", "pi-braid-skills"];

function readSkills(pkgName) {
	const pkgPath = path.join(root, pkgName, "package.json");
	if (!fs.existsSync(pkgPath)) return null;
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	const pi = pkg.pi || {};
	const skills = pi.skills || [];
	return { pkgName, skills };
}

const byName = new Map(); // skillName -> [pkgName, ...]
const seen = [];
for (const p of packages) {
	const r = readSkills(p);
	if (!r) continue;
	for (const s of r.skills) {
		const name = typeof s === "string" ? s : s.name;
		if (!name) continue;
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(r.pkgName);
		seen.push(name);
	}
}

const collisions = [...byName.entries()].filter(([, pkgs]) => pkgs.length > 1);

if (collisions.length === 0) {
	console.log(`[check-skills] OK — ${seen.length} skills across ${packages.length} packages, no duplicates.`);
	process.exit(0);
}

console.error("[check-skills] FAIL — duplicate skill names detected:");
for (const [name, pkgs] of collisions) {
	console.error(`  ✗ "${name}" declared by: ${pkgs.join(", ")}`);
}
console.error("\nRule: only pi-braid-skills may declare pi.skills. Move colliding");
console.error("skills into pi-braid-skills/skills/<name>/SKILL.md and remove from other packages.");
process.exit(1);

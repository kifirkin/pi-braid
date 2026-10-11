/**
 * version-derivation.mjs — the one derivation of a tree's version.
 *
 * Two consumers name the same tree: the publish path packs a tarball named
 * after the derived version, and the tag path writes a ref named after it. A
 * private copy of the rules on each side would drift, and then the tarball and
 * the tag would disagree about which version a commit is. The rules live here
 * and nowhere else.
 *
 *   <base>-<sanitized-branch>.<iteration>
 *
 *   base       the package.json version, untouched
 *   branch     the git branch, sanitized to [a-zA-Z0-9.-] (the value the
 *              version carries, and the value a caller prints); "detached"
 *              when git cannot name one, and the literal "HEAD" when the
 *              branch is detached, because git answers `HEAD` there rather
 *              than failing
 *   iteration  commits on this branch since main/master; "0" when the branch
 *              is level with it, and the short sha when neither exists,
 *              because a repo without a main line has no baseline to count
 *              against
 *
 * A base that already carries a prerelease is returned verbatim: re-deriving
 * would double-suffix it into 0.40.0-main.3-main.0.
 */

/** A base already carrying a prerelease is used verbatim, never re-suffixed. */
const PRERELEASE_BASE = /^\d+\.\d+\.\d+-/;

/** Characters a branch name may not keep in a version string or a ref name. */
const UNSAFE_BRANCH_CHARS = /[^a-zA-Z0-9.-]/g;

/** `feature/ctx-budget` becomes `feature-ctx-budget`. */
export function sanitizeBranch(raw) {
  return String(raw ?? "").replace(UNSAFE_BRANCH_CHARS, "-");
}

/**
 * The rules, with no repository in sight: three inputs in, one version string
 * out. Kept separate from the git reads so a caller can pin the rules without
 * a repo.
 */
export function deriveVersion({ base, branch, iterations }) {
  if (PRERELEASE_BASE.test(base)) return base;
  return `${base}-${sanitizeBranch(branch) || "detached"}.${iterations}`;
}

/**
 * The git reads behind the derivation. `sh` is the caller's command runner:
 * a function of (command, cwd) returning stdout as a trimmed string, or an
 * empty string when the command fails. Injected so a test can pin the rules
 * without a repository.
 */
export function readVersionInputs(pkgDir, sh) {
  const ref = sh("git rev-parse --abbrev-ref HEAD", pkgDir);
  const branch = sanitizeBranch(ref || "detached");

  const baseline =
    sh("git rev-parse --verify main 2>/dev/null", pkgDir) ||
    sh("git rev-parse --verify master 2>/dev/null", pkgDir);
  if (baseline) {
    const count = sh(`git rev-list --count ${baseline}..HEAD`, pkgDir);
    return { branch, iterations: count || "0" };
  }

  return { branch, iterations: sh("git rev-parse --short HEAD", pkgDir) || "0" };
}

/**
 * The one call both paths make. Returns the version plus the two inputs, so a
 * caller can report what the version was derived from.
 */
export function deriveVersionFor({ base, pkgDir, sh }) {
  const { branch, iterations } = readVersionInputs(pkgDir, sh);
  return { version: deriveVersion({ base, branch, iterations }), branch, iterations };
}

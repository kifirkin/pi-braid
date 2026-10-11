/**
 * semver.mjs — version precedence per semver.org 2.0.0.
 *
 * Only what the tag path needs: parse a version, order two versions, pick the
 * highest. Build metadata is ignored, so two versions that differ only in
 * `+...` compare equal (rule 10). A prerelease sorts below the release it
 * precedes (11.3), and prerelease identifiers compare numerically when both
 * are numeric and in ASCII order otherwise (11.4). That is what makes
 * 0.40.0-main.3 < 0.40.0 while 0.40.0-main.10 > 0.40.0-main.3 — a plain
 * string sort gets the second one backwards.
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const NUMERIC = /^\d+$/;

/** Rule 2: a numeric identifier may not carry a leading zero. */
function hasLeadingZero(part) {
  return part.length > 1 && part.startsWith("0");
}

/**
 * Parse a version, or return null when it is not valid semver. Build metadata
 * is parsed but not returned: nothing downstream may order by it.
 */
export function parseVersion(text) {
  const match = VERSION_RE.exec(String(text ?? "").trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if ([major, minor, patch].some(hasLeadingZero)) return null;

  const version = { major: Number(major), minor: Number(minor), patch: Number(patch) };
  if (prerelease === undefined) return { ...version, prerelease: null };

  const identifiers = prerelease.split(".");
  const malformed = identifiers.some(
    (id) => id === "" || (NUMERIC.test(id) && hasLeadingZero(id)),
  );
  if (malformed) return null;
  return { ...version, prerelease: identifiers };
}

export function isValidVersion(text) {
  return parseVersion(text) !== null;
}

/** A version's release part: `0.40.0-main.3` -> `0.40.0`. */
export function releaseOf(text) {
  const parsed = parseVersion(text);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function isPrerelease(text) {
  const parsed = parseVersion(text);
  return parsed !== null && parsed.prerelease !== null;
}

/**
 * Precedence: -1 when `a` sorts below `b`, 1 when above, 0 when equal. Both
 * arguments must be valid semver; an unparseable version is a caller bug, not
 * an ordering.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new TypeError(`compareVersions: not valid semver: ${!left ? a : b}`);
  }

  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }

  // 11.3: a prerelease has lower precedence than the release it precedes.
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;

  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    const lNumeric = NUMERIC.test(l);
    const rNumeric = NUMERIC.test(r);
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
      continue;
    }
    // 11.4.3: numeric identifiers always sort below non-numeric ones.
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }

  // 11.4.4: a larger set of identifiers wins when all preceding ones are equal.
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/** The highest of the versions that parse, or null when none does. */
export function highestVersion(versions) {
  let highest = null;
  for (const version of versions) {
    if (!isValidVersion(version)) continue;
    if (highest === null || compareVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

/**
 * Native section parity registry for the prompt-builder.
 *
 * braid publishes its prompt through pi's section seam instead of forcing a
 * single system prompt. That seam is additive: pi renders every native section
 * plus every `sections` entry the options carry, so a native section braid does
 * not neutralize reaches the model.
 * Every native section key therefore carries a recorded disposition here, and
 * the parity test derives pi's live key set from its installed builder and
 * fails on any key this registry does not name.
 *
 * The registry also names the decisions that never appear as rendered
 * section keys: the caller-supplied `sections` mechanism, the options-level
 * `promptGuidelines` (dropped), and the `customPrompt` policy (a user
 * `.pi/SYSTEM.md` is never read; braid's stable group takes the preamble slot
 * and braid's identity is the product).
 *
 * Limits: pi exports no section builder, so this check cannot run in-process
 * at runtime; the parity test imports pi's internal
 * `dist/core/system-prompt.js` by resolved file URL because the package's
 * exports map blocks subpath imports. The seam is test-only and fails loudly
 * if pi relocates the module.
 */
export type NativeSectionDisposition = "rendered" | "replaced" | "preserved" | "dropped";

export interface NativeSectionPolicy {
  readonly key: string;
  readonly disposition: NativeSectionDisposition;
  readonly reason: string;
}

export const NATIVE_SECTION_POLICY: readonly NativeSectionPolicy[] = [
  {
    key: "preamble",
    disposition: "replaced",
    reason:
      "braid's stable group is published as customPrompt and rendered as the preamble; the generic native preamble is not reused",
  },
  {
    key: "tools",
    disposition: "replaced",
    reason:
      "braid's tools section renders owned guideline rows; descriptions ride the API tools channel",
  },
  {
    key: "rules",
    disposition: "replaced",
    reason: "braid's guidelines section owns the cross-tool rules",
  },
  {
    key: "docs",
    disposition: "dropped",
    reason:
      "the pi-reference skill owns pi's docs index and paths; the prompt carries only a pointer to that skill",
  },
  {
    key: "addendum",
    disposition: "preserved",
    reason:
      "appendSystemPrompt is re-appended as braid's deduped append section; the native option is emptied so it is not rendered twice",
  },
  {
    key: "project_context",
    disposition: "replaced",
    reason:
      "pointer-only project docs, read on demand; contextFiles is emptied so the native inline content is not injected",
  },
  {
    key: "skills",
    disposition: "replaced",
    reason:
      "list_skills serves discovery; the skills collection is emptied so no catalog is inlined",
  },
  {
    key: "cwd",
    disposition: "rendered",
    reason:
      "pi renders cwd unconditionally; the compact Instance line carries cwd, model, and session as well",
  },
  {
    key: "sections",
    disposition: "rendered",
    reason:
      "caller entries are read from the options and rendered into braid's stable group; the map is then replaced by braid's own named sections",
  },
  {
    key: "promptGuidelines",
    disposition: "dropped",
    reason:
      "options-level embedder bullets; braid owns its guideline set and the CLI leaves this empty",
  },
  {
    key: "customPrompt",
    disposition: "dropped",
    reason:
      "a user .pi/SYSTEM.md is never read: braid's identity is the product, and the slot carries braid's stable group (documented policy)",
  },
];

const LISTED = new Set(NATIVE_SECTION_POLICY.map((entry) => entry.key));

/**
 * Native section keys with no recorded disposition, sorted and deduplicated.
 * Empty means every key pi rendered is an explicit braid decision.
 */
export function unlistedNativeSections(nativeKeys: Iterable<string>): string[] {
  return [...new Set(nativeKeys)].filter((key) => !LISTED.has(key)).sort();
}

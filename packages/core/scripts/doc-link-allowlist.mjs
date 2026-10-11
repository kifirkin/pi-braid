/**
 * doc-link-allowlist.mjs — doc references that live outside this repo.
 *
 * check-doc-links.mjs can only verify paths inside this checkout. References
 * to another package's docs (pi-core, installed as a dependency) resolve in
 * that package's tree, not here; they are sanctioned here, one row each,
 * instead of failing the gate forever.
 *
 * Shape: { ref: the exact reference as written, source: optional file path
 * or directory prefix the reference may appear in, because: one line of why
 * this is external and fine }.
 */
export const EXTERNAL_DOC_REFS = [
  // pi-core's own documentation, indexed by the pi-reference skill for
  // questions about the host agent (braid does not own these files).
  { ref: "docs/extensions.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/themes.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/skills.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/prompt-templates.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/tui.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/keybindings.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/sdk.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/custom-provider.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/models.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/packages.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/rpc.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/sessions.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/settings.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
  { ref: "docs/compaction.md", source: "packages/core/skills/pi-reference/", because: "pi-core doc, resolved in the installed pi package" },
];

// Root lint entry. The rule set is defined once in packages/core/eslint.config.js
// (re-exported here) and shared by every package. That config pins core's
// tsconfig via parserOptions.project; each sibling package gets a later,
// files-scoped block with its own tsconfig — flat config merges languageOptions,
// so the later block wins for the files it matches.
import coreConfig from "./packages/core/eslint.config.js";

const packageScope = (glob, packageDir) => ({
  files: [glob],
  languageOptions: {
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: `${import.meta.dirname}/packages/${packageDir}`,
    },
  },
});

export default [
  ...coreConfig,
  packageScope("packages/providers/**/*.ts", "providers"),
  packageScope("packages/contrib/**/*.ts", "contrib"),
  packageScope("packages/telegram/src/**/*.ts", "telegram"),
  {
    // Console transports: the contrib logger's console sink and the two
    // manual smoke scripts print to stdout/stderr by design — they are not
    // TUI code paths (see packages/core/src/AGENTS.md delivery channels).
    files: [
      "packages/contrib/logger.ts",
      "packages/contrib/network-monitor/test.ts",
      "packages/contrib/test-repl.ts",
    ],
    rules: { "no-console": "off" },
  },
];

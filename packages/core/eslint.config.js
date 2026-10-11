import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import pluginPrettier from "eslint-plugin-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: {
      prettier: pluginPrettier,
    },
    rules: {
      "prettier/prettier": "warn",
      // Enforce spaces (match .prettierrc useTabs:false)
      "indent": "off",
      "no-tabs": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_|^log$",
          caughtErrorsIgnorePattern: "^_$",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // Project has many as-any casts for undocumented SDK types - warnings only
      "@typescript-eslint/no-unsafe-argument": "off",
      // Remaining 60 sites (down from 54→4 as any) are at pi SDK boundaries
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      // A swallow must say why it is safe at the point of swallowing: a
      // comment inside the block satisfies this rule, a bare {} does not.
      "no-empty": "error",
    },
    languageOptions: {
      parserOptions: {
        // Config-relative absolute paths so the TS parser resolves regardless of
        // cwd: root `npm run lint` runs this config with cwd = repo root, where
        // tsconfig.json no longer exists (removed with the 89b24206 dedup).
        project: `${import.meta.dirname}/tsconfig.json`,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain-JS entry points (test drivers, maintenance scripts) are not in the
    // TS project; parse them without type information. They keep the shared
    // rule set, with the Node built-ins their runtime provides declared so
    // no-undef still catches misspelled globals.
    files: ["**/*.mjs"],
    languageOptions: {
      parserOptions: {
        project: null,
      },
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
        File: "readonly",
        FormData: "readonly",
        Response: "readonly",
        URL: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        queueMicrotask: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    // Test drivers and maintenance scripts speak to stdout by design: their
    // console output is the report, not a TUI code path - the same rule the
    // root config applies to the contrib console transports. Drop this
    // exemption if the console transports move onto the logger.
    files: ["**/test/**/*.mjs", "**/scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "docs/**",
      "braid-os/**",
      "*.js",
      ".tmp/**",
      ".eslintcache",
    ],
  },
);

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import pluginPrettier from "eslint-plugin-prettier";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	prettier,
	{
		plugins: {
			prettier: pluginPrettier
		},
		rules: {
			"prettier/prettier": "error",
			// Enforce spaces (match .prettierrc useTabs:false)
			"indent": ["error", 2, { "SwitchCase": 1 }],
			"no-tabs": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-floating-promises": "error",
			"no-console": ["warn", { allow: ["warn", "error"] }],
			"no-debugger": "error"
		},
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: process.cwd()
			}
		}
	},
	{
		ignores: [
			"dist/**",
			"node_modules/**",
			"coverage/**",
			"evaluation/**",
			"docs/**",
			"braid-os/**",
			"scripts/**",
			"test/**",
			"*.js",
			"*.mjs",
			".tmp/**",
			".eslintcache"
		]
	}
);

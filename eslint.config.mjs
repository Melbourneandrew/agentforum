import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import hooks from "eslint-plugin-react-hooks";
import a11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  {
    ignores: [
      ".repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.wrangler/**",
      "**/.turbo/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  {
    ...react.configs.flat.recommended,
    files: ["apps/web/**/*.tsx"],
    settings: { react: { version: "detect" } },
  },
  { ...react.configs.flat["jsx-runtime"], files: ["apps/web/**/*.tsx"] },
  { ...hooks.configs.flat.recommended, files: ["apps/web/**/*.tsx"] },
  { ...a11y.flatConfigs.recommended, files: ["apps/web/**/*.tsx"] },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/.repos/**"],
              message:
                "Vendored upstream source is read-only reference, never application input.",
            },
          ],
        },
      ],
    },
  },
);

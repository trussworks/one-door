// Created by repo-harness; local edits are allowed.
import js from "@eslint/js";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "out/**",
      "coverage/**",
      ".next/**",
      ".nuxt/**",
      ".harness/**",
      "playwright-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: ["**/*.tsx", "**/*.jsx"],
    ...jsxA11y.flatConfigs.recommended,
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Labeled focusable regions (scrollable notes and tables) follow the
      // W3C pattern that pairs tabIndex 0 with role="region" and a label.
      "jsx-a11y/no-noninteractive-tabindex": [
        "error",
        {
          tags: [],
          roles: ["tabpanel", "region"],
          allowExpressionValues: true,
        },
      ],
      // WebKit drops list semantics under list-style: none; role="list"
      // restores them, so it is not redundant on ul.
      "jsx-a11y/no-redundant-roles": ["error", { ul: ["list"] }],
    },
    settings: {
      "jsx-a11y": {
        // Wrappers that render exactly one underlying element; composites
        // (Field, Checkbox, Alert, SideNav, Table) stay unmapped.
        components: {
          Button: "button",
          Label: "label",
          Select: "select",
          Textarea: "textarea",
          TextInput: "input",
        },
      },
    },
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      complexity: ["error", { max: 10 }],
      "max-depth": ["error", 4],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "max-statements": ["error", 30],
      "max-params": "off",
      "@typescript-eslint/max-params": ["error", { max: 4 }],
      "sonarjs/cognitive-complexity": ["error", 15],
    },
  },
);

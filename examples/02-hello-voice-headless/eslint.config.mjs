// SPDX-License-Identifier: MIT

import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const nodeGlobals = {
  AbortSignal: "readonly",
  Buffer: "readonly",
  console: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  fetch: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "test/performance/runs/**",
    ],
  },
  ...tseslint.configs["flat/recommended"],
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: nodeGlobals,
      parser: tsParser,
      sourceType: "module",
    },
  },
];

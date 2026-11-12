import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * SECURITY.md rule 6: never render user text as HTML. These selectors fail
 * the build (`pnpm build` runs eslint first) on every way into the HTML
 * parser from script: React's dangerouslySetInnerHTML, innerHTML and
 * outerHTML (read or written), insertAdjacentHTML, document.write and
 * createContextualFragment.
 */
const NO_HTML_INJECTION = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML is banned (SECURITY.md rule 6). Render text as React children.",
  },
  {
    selector: "Property[key.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML is banned (SECURITY.md rule 6). Render text as React children.",
  },
  {
    selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
    message: "innerHTML and outerHTML are banned (SECURITY.md rule 6). Use textContent or React.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment|parseFromString)$/]",
    message: "Parsing strings as HTML is banned (SECURITY.md rule 6).",
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: "document.write is banned (SECURITY.md rule 6).",
  },
];

export default tseslint.config(
  { ignores: ["dist/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-syntax": ["error", ...NO_HTML_INJECTION],
      // The CLAUDE.md randomness rule: the client never rolls anything.
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "No Math.random in the client (CLAUDE.md security rule 2)." },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}", "e2e/**/*.{ts,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
);

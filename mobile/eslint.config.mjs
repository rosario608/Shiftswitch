import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Lint config for the native client.
 *
 * It borrows the repository's existing ESLint installation (resolved from the
 * parent node_modules) rather than installing a second copy, so both packages
 * are held to the same React and TypeScript rules. The Next-specific rules
 * about pages and links do not apply here and are switched off.
 *
 * Run from the repository root:  npm run lint:mobile
 */
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    "dist/**",
    "android/**",
    "ios/**",
    "node_modules/**",
  ]),
  {
    rules: {
      // This is a Vite SPA: there is no Next router, no next/image and no
      // pages directory for these rules to be about.
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-img-element": "off",
    },
  },
]);

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    /* The Cloudflare adapter's output: a copy of the Next server, the Next
       runtime and a vendored `node_modules`, all machine-written. Linting it
       reported 31,920 problems in code nobody wrote and nobody can fix, and
       buried the ones that matter. */
    ".open-next/**",
    // Generated or foreign to this package: the native projects are produced
    // by `cap add`, and the mobile client is linted by its own config.
    "mobile/**",
    "release/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;

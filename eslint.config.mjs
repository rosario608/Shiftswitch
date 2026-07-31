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
    // Generated or foreign to this package: the native projects are produced
    // by `cap add`, and the mobile client is linted by its own config.
    "mobile/**",
    "release/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;

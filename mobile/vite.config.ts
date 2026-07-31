import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";

/**
 * The native app is a fully compiled client. It is bundled into the Capacitor
 * container and served from the app package — it never loads the website.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  if (mode === "production") {
    // Fail the build rather than shipping a store binary that talks to a
    // developer's laptop. scripts/check-release-env.ts repeats this check from
    // the outside; this one makes it impossible to bypass by running vite
    // directly.
    const apiUrl = env.VITE_API_URL ?? "";
    if (!apiUrl) {
      throw new Error("VITE_API_URL is required for a production build.");
    }
    if (!apiUrl.startsWith("https://")) {
      throw new Error(`VITE_API_URL must be https (got "${apiUrl}").`);
    }
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(apiUrl)) {
      throw new Error(`VITE_API_URL must not point at a local host ("${apiUrl}").`);
    }
    if (env.VITE_ALLOW_TEST_LOGIN === "true") {
      throw new Error("VITE_ALLOW_TEST_LOGIN must not be enabled in a production build.");
    }
  }

  return {
    plugins: [react(), tailwind()],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "src") },
    },
    build: {
      outDir: "dist",
      sourcemap: mode !== "production",
      target: "es2022",
    },
    server: {
      port: 5173,
      host: true,
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});

#!/usr/bin/env tsx
/**
 * The one command that decides whether the repository is in a good state.
 *
 *   npm run verify        everything, ~8 minutes, what "done" means
 *   npm run verify:fast   typecheck, lint, unit + integration — the inner loop
 *
 * One exit code. Non-interactive. Nothing here prompts, opens a browser, or
 * needs a credential beyond a local PostgreSQL. It is the same list CI runs,
 * so "green locally, red in CI" should mean a real environment difference
 * rather than a step somebody forgot.
 *
 * ## Order
 *
 * Cheapest first, so an obvious mistake fails in seconds rather than after the
 * end-to-end suites. Two orderings are deliberate rather than incidental:
 *
 *   - `build` runs *before* the Playwright suites. Both Playwright configs
 *     start `next dev`, and `next dev` and `next build` contend over `.next`.
 *     Building first means no dev server is running yet.
 *   - The from-scratch migration runs *last*. It drops and rebuilds the test
 *     schema, which would pull the ground out from under any step that came
 *     after it.
 *
 * ## What it touches
 *
 * Two local databases, both disposable:
 *
 *   - the **test** database (`TEST_DATABASE_URL`) for vitest and the final
 *     rebuild-from-scratch check;
 *   - the **development** database (`DATABASE_URL` from `.env.local`) for the
 *     end-to-end suites, because that is the database the dev server uses.
 *
 * Every end-to-end spec rebuilds `scripts/e2e-fixture.ts` in `beforeAll`, and
 * that fixture truncates every table. **Running verify therefore destroys the
 * local demo program.** `npm run demo:seed` puts it back. Both scripts refuse
 * to run against anything that does not look local — see `scripts/db-guard.ts`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import { loadEnv } from "./load-env";

interface Step {
  name: string;
  command: string;
  args: string[];
  /** Extra environment for this step only. */
  env?: Record<string, string>;
  /** Skipped by verify:fast. */
  slow?: boolean;
}

const STEPS: Step[] = [
  { name: "typecheck", command: "npx", args: ["tsc", "--noEmit"] },
  { name: "lint (server + web)", command: "npx", args: ["eslint"] },
  {
    name: "lint (native client)",
    command: "npx",
    args: ["eslint", "--config", "mobile/eslint.config.mjs", "mobile/src", "mobile/scripts"],
    slow: true,
  },
  { name: "unit + integration", command: "npx", args: ["vitest", "run"] },
  {
    name: "native client unit suite",
    command: "npm",
    args: ["--prefix", "mobile", "run", "test"],
    slow: true,
  },
  { name: "production build", command: "npm", args: ["run", "build"], slow: true },
  /**
   * The artefact that actually gets deployed.
   *
   * `next build` passing says nothing about whether this runs on Cloudflare.
   * Three of the four things that broke the migration were invisible to it and
   * appeared only here: a Node.js proxy the adapter refuses outright, an
   * optional `pg` dependency that file tracing never copied into the standalone
   * output, and lint walking the generated bundle. Each would otherwise have
   * been found by a failed deploy rather than a failed check — which for this
   * product means found by a resident.
   */
  {
    name: "cloudflare worker build",
    command: "npm",
    args: ["run", "build:worker"],
    slow: true,
  },
  /**
   * And whether the thing that was just built can actually be uploaded.
   *
   * Cloudflare's free plan refuses a Worker script over 3 MiB gzipped, and this
   * one is within a few percent of that. The refusal happens at deploy — which
   * is to say, at the moment somebody is trying to ship a fix — so the size is
   * checked here instead, next to the diff that changed it.
   */
  {
    name: "cloudflare worker size",
    command: "npm",
    args: ["run", "check:worker-size"],
    slow: true,
  },
  {
    name: "end-to-end (web)",
    command: "npx",
    args: ["playwright", "test"],
    slow: true,
  },
  {
    name: "end-to-end (native)",
    command: "npx",
    args: ["playwright", "test", "--config", "playwright.mobile.config.ts"],
    slow: true,
  },
  {
    /* Proves every migration applies to an empty database in order — the thing
       a developer's incrementally-migrated database can never demonstrate,
       because it has been carrying the result since whenever each one landed.
       NODE_ENV=test makes `loadEnv` pick `.env.test`, so this drops the test
       database and never the development one. */
    name: "migrations from scratch",
    command: "npx",
    args: ["tsx", "scripts/migrate.ts", "--reset"],
    env: { NODE_ENV: "test" },
    slow: true,
  },
  {
    name: "integration suite against the rebuilt schema",
    command: "npx",
    args: ["vitest", "run", "tests/integration"],
    slow: true,
  },
];

function run(step: Step): boolean {
  const started = Date.now();
  process.stdout.write(`\n▶ ${step.name}\n`);
  /* `CI` is passed through, never forced.
     An earlier version set `CI=1` so Playwright would always start its own
     servers. That also turns on `retries: 1`, which is exactly wrong here — a
     command whose job is to say whether the tree is good should show a flake
     rather than paper over it — and it makes the native config refuse to reuse
     a server, so `verify` failed on any machine that happened to have the dev
     server running. Real CI sets `CI` itself and gets both behaviours. */
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    env: { ...process.env, ...step.env },
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.status === 0) {
    process.stdout.write(`✓ ${step.name} (${seconds}s)\n`);
    return true;
  }
  process.stdout.write(
    `✗ ${step.name} (${seconds}s) — exit ${result.status ?? "signal " + result.signal}\n`,
  );
  return false;
}

/**
 * Fail on the one precondition with an unhelpful failure mode.
 *
 * With PostgreSQL down, the integration suite reports thirteen separate file
 * errors whose visible cause is `ECONNREFUSED` inside a migration subprocess —
 * which reads like a broken test suite rather than a service that is not
 * running. One line up front is worth more than any amount of scrollback.
 */
async function preflight(): Promise<boolean> {
  /* `mobile/` is a separate npm package rather than a workspace, so a root
     `npm ci` leaves it uninstalled. Three steps below need it, and the failure
     is opaque — vitest reports an unresolved import inside `vite.config.ts`,
     which reads like a broken config rather than absent dependencies. */
  if (!existsSync(path.join(process.cwd(), "mobile", "node_modules"))) {
    process.stdout.write(
      "[verify] mobile/node_modules is missing — it is a separate package, not a workspace.\n" +
        "[verify] Run `npm --prefix mobile ci` (or `npm run setup:local`).\n",
    );
    return false;
  }

  /* A dev server already listening is the other precondition with a failure
     mode nobody can read. `next dev` and `next build` share `.next`, so the
     build step corrupts the running server's compiled output, and what surfaces
     several minutes later is three or four end-to-end tests failing on
     `ECONNRESET` and phantom strict-mode violations — which reads like flaky
     tests rather than the one thing that actually went wrong. Playwright will
     start its own server; it only needs this one out of the way. */
  const port = Number(process.env.PORT ?? 3000);
  if (await somethingIsListening(port)) {
    process.stdout.write(
      `[verify] Something is already listening on port ${port}.\n` +
        "[verify] `next dev` and `next build` share .next, so a dev server left running\n" +
        "[verify] is corrupted by the build step and the end-to-end suites fail in ways\n" +
        "[verify] that look like flakes. Stop it and run this again.\n",
    );
    return false;
  }

  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    process.stdout.write(
      "[verify] No DATABASE_URL or TEST_DATABASE_URL.\n" +
        "[verify] Run `npm run setup:local` — it creates the databases and writes .env.local.\n",
    );
    return false;
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `[verify] Cannot reach PostgreSQL at ${new URL(url).host}: ${message}\n` +
        "[verify] Start it first — on Debian/Ubuntu: service postgresql start\n" +
        "[verify] Then `npm run setup:local` if this is a fresh checkout.\n",
    );
    return false;
  }
}

/** True if a TCP connection to localhost:port is accepted. */
function somethingIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function main(): Promise<void> {
  loadEnv();
  if (!(await preflight())) process.exit(1);
  const fast = process.argv.includes("--fast");
  const steps = fast ? STEPS.filter((step) => !step.slow) : STEPS;

  process.stdout.write(
    `[verify] ${steps.length} steps${fast ? " (fast: static checks and tests only)" : ""}\n`,
  );

  const started = Date.now();
  const failed: string[] = [];
  for (const step of steps) {
    if (!run(step)) {
      failed.push(step.name);
      // Fail fast: later steps are rarely informative once something is broken,
      // and the end-to-end suites are slow enough that waiting for them to also
      // fail wastes several minutes.
      break;
    }
  }

  const total = ((Date.now() - started) / 1000).toFixed(0);
  if (failed.length > 0) {
    process.stdout.write(`\n[verify] FAILED at "${failed[0]}" after ${total}s\n`);
    process.exit(1);
  }
  process.stdout.write(
    `\n[verify] all ${steps.length} steps passed in ${total}s\n` +
      (fast
        ? "[verify] this was verify:fast — run `npm run verify` before committing\n"
        : "[verify] the end-to-end fixture truncated the dev database; `npm run demo:seed` restores the demo program\n"),
  );
}

main().catch((error) => {
  console.error("[verify] crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});

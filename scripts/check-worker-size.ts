#!/usr/bin/env tsx
/**
 * Does the deployable Worker still fit on Cloudflare's free plan?
 *
 *     npm run check:worker-size        (after `npm run build:worker`)
 *
 * Cloudflare refuses to upload a Worker whose script exceeds **3 MiB gzipped**
 * on the free plan. Not "warns", not "throttles" — the upload is rejected and
 * whatever is currently deployed keeps serving. Which means the failure lands
 * at the moment of deploying a fix, not at the moment of writing the import
 * that caused it.
 *
 * This project sits close enough to that line for the distance to matter.
 * Removing `pdfkit` is what bought the headroom, and a single careless
 * dependency puts it back: `pdfkit` alone was 256 KiB. So the size is checked
 * here, in `verify` and in CI, where the answer is a failed check somebody can
 * read next to the diff that caused it.
 *
 * ## What is measured
 *
 * Wrangler's own number, from `wrangler deploy --dry-run` — the same figure the
 * upload is judged against. Not an estimate of it, and not a directory listing
 * summed by hand, because either would be a second implementation of a rule
 * only Cloudflare gets to decide. `--dry-run` builds and reports; it contacts
 * no account and needs no credential.
 *
 * Static assets under `.open-next/assets` are not part of this and are not
 * counted by wrangler either — they are served from Cloudflare's asset store,
 * not from the script.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** The free plan's hard ceiling. Paid plans get 10 MiB. */
const LIMIT_KIB = 3 * 1024;

/**
 * Report a warning below this much headroom.
 *
 * Chosen as roughly one careless dependency: `pdfkit` was 256 KiB, `exceljs`
 * is larger. 150 KiB left means the next thing anybody adds is likely to be
 * the thing that breaks the deploy, and that is worth saying before it does
 * rather than after.
 */
const WARN_HEADROOM_KIB = 150;

function fail(message: string): never {
  process.stdout.write(`[worker-size] ${message}\n`);
  process.exit(1);
}

function main(): void {
  const worker = path.join(process.cwd(), ".open-next", "worker.js");
  if (!existsSync(worker)) {
    fail(
      "No .open-next/worker.js — run `npm run build:worker` first.\n" +
        "[worker-size] (In verify and CI the build step runs immediately before this one.)",
    );
  }

  const result = spawnSync("npx", ["wrangler", "deploy", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    process.stdout.write(output);
    fail(`wrangler deploy --dry-run exited ${result.status ?? result.signal}`);
  }

  /* Wrangler prints e.g. `Total Upload: 9876.54 KiB / gzip: 3000.51 KiB`. If
     that line ever stops appearing, this check has quietly stopped checking
     anything — so a missing match is a failure, not a pass. */
  const match = /gzip:\s*([\d.]+)\s*KiB/i.exec(output);
  if (!match) {
    process.stdout.write(output);
    fail(
      "Could not find a gzip size in wrangler's output.\n" +
        "[worker-size] Wrangler's reporting format may have changed; this check needs updating.",
    );
  }

  const gzipKib = Number(match[1]);
  const headroom = LIMIT_KIB - gzipKib;
  const percent = ((gzipKib / LIMIT_KIB) * 100).toFixed(1);
  const line =
    `${gzipKib.toFixed(2)} KiB gzipped of ${LIMIT_KIB} KiB (${percent}%), ` +
    `${headroom.toFixed(2)} KiB spare`;

  if (headroom < 0) {
    process.stdout.write(`[worker-size] ${line}\n`);
    fail(
      "Over Cloudflare's free-plan limit. The deploy would be refused.\n" +
        "[worker-size] Find what grew: `npx wrangler deploy --dry-run --outdir /tmp/w` and\n" +
        "[worker-size] look at the largest modules. A server-only dependency imported from a\n" +
        "[worker-size] shared module is the usual cause — it reaches the bundle through the\n" +
        "[worker-size] import graph even when only one route uses it.",
    );
  }

  process.stdout.write(`[worker-size] ${line}\n`);
  if (headroom < WARN_HEADROOM_KIB) {
    process.stdout.write(
      `[worker-size] WARNING: under ${WARN_HEADROOM_KIB} KiB of headroom. One more\n` +
        "[worker-size] dependency of any size will make the deploy fail rather than this check.\n",
    );
  }
}

main();

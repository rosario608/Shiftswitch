import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * Running this Next.js app on Cloudflare Workers.
 *
 * ## No incremental cache, deliberately
 *
 * The adapter's default template wires an R2 bucket as an incremental cache.
 * That is right for a content site and close to pointless here: every route
 * that matters is `export const dynamic = "force-dynamic"`, because a schedule
 * that is cached is a schedule that is wrong, and this product's whole claim is
 * that what you are looking at is what you are working.
 *
 * Leaving it out costs nothing and removes a resource that would otherwise have
 * to exist before the first deploy succeeds. If a genuinely static page appears
 * later, add `r2IncrementalCache` here and create the bucket then.
 */
export default defineCloudflareConfig();

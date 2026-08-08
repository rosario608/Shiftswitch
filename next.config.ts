import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow the loopback IP as well as localhost so end-to-end tests
  // can drive the dev server from either host.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  /**
   * `pg` reaches the network through `pg-cloudflare` when it runs on Workers —
   * that package is what turns a Postgres connection into a `cloudflare:sockets`
   * socket. It is an *optional* require inside `pg/lib/stream.js`, so Next's
   * file tracing does not see it, the standalone output omits it, and the
   * Worker bundle then fails to resolve it at build time.
   *
   * Forcing it into the trace is the whole fix. Harmless under Node: `pg` only
   * reaches for it when the Workers socket API is present.
   */
  outputFileTracingIncludes: {
    "/*": ["./node_modules/pg-cloudflare/**/*"],
  },
  poweredByHeader: false,
  // The dev overlay indicator sits on top of the bottom navigation on a phone
  // viewport, so it is hidden; compile and runtime errors still surface.
  devIndicators: false,
  async redirects() {
    /* The screens were renamed when the product settled on one word for the
       exchange. Links were not: they are in push notifications already
       delivered, in emails already sent, in `notifications.route` rows written
       before the rename, and in messages residents forwarded to each other.
       Permanent redirects keep every one of them working. A dead link is a dead
       end, and this is four lines. */
    return [
      { source: "/trades", destination: "/switches", permanent: true },
      { source: "/trades/:id", destination: "/switches/:id", permanent: true },
    ];
  },
  async rewrites() {
    // Deep-link association files must live at /.well-known with exact content
    // types; they are generated from environment configuration.
    return [
      {
        source: "/.well-known/assetlinks.json",
        destination: "/api/well-known/assetlinks",
      },
      {
        source: "/.well-known/apple-app-site-association",
        destination: "/api/well-known/apple-app-site-association",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

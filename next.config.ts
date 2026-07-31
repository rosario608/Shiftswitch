import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow the loopback IP as well as localhost so end-to-end tests
  // can drive the dev server from either host.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  // The dev overlay indicator sits on top of the bottom navigation on a phone
  // viewport, so it is hidden; compile and runtime errors still surface.
  devIndicators: false,
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

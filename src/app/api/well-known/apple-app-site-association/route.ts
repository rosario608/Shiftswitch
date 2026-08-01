export const dynamic = "force-dynamic";

/**
 * Apple App Site Association — the iOS half of the same handshake, enabling
 * universal links into the app.
 *
 * Served at /.well-known/apple-app-site-association via a rewrite, with
 * `application/json` and no file extension, as Apple requires.
 */
export function GET() {
  const teamId = process.env.APPLE_TEAM_ID ?? "TEAMID0000";
  const bundleId = process.env.IOS_BUNDLE_ID ?? "org.shiftswitch.app";
  const appId = `${teamId}.${bundleId}`;

  const body = {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: [
            { "/": "/switches/*", comment: "A posted shift or an offer on it" },
            { "/": "/switches/*", comment: "A completed switch" },
            { "/": "/schedule/*", comment: "A single shift" },
            { "/": "/notifications", comment: "Notification list" },
            { "/": "/admin/approvals", comment: "Chief approval queue" },
          ],
        },
      ],
    },
    webcredentials: { apps: [appId] },
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
  });
}

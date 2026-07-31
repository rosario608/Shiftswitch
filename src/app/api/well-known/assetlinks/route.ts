export const dynamic = "force-dynamic";

/**
 * Digital Asset Links — proves this domain and the Android app belong together,
 * so `https://<domain>/trades/...` opens the app instead of a browser tab.
 *
 * Served at /.well-known/assetlinks.json via a rewrite in next.config.ts.
 * ANDROID_CERT_FINGERPRINTS holds the SHA-256 fingerprints of the signing
 * certificates (comma-separated). With Play App Signing this is the fingerprint
 * Google shows under Release → Setup → App signing, not the upload key.
 */
export function GET() {
  const packageName = process.env.ANDROID_PACKAGE_NAME ?? "org.shiftswitch.app";
  const fingerprints = (process.env.ANDROID_CERT_FINGERPRINTS ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
  });
}

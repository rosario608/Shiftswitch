import type { MetadataRoute } from "next";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ShiftSwitch";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${APP_NAME} — Residency shift trading`,
    short_name: APP_NAME,
    description:
      "Post a shift, find a compatible resident, and complete an approved switch from your phone.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0f5a69",
    categories: ["medical", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "My schedule", url: "/schedule" },
      { name: "Available trades", url: "/trades" },
    ],
  };
}

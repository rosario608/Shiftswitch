import type { Metadata, Viewport } from "next";
import "./globals.css";
import { OfflineBanner } from "@/components/app/offline-banner";
import { ServiceWorkerRegistrar } from "@/components/app/service-worker";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ShiftSwitch";

export const metadata: Metadata = {
  title: {
    default: `${APP_NAME} — Residency shift trading`,
    template: `%s · ${APP_NAME}`,
  },
  description:
    "Post a shift, find a compatible resident, and complete an approved switch from your phone.",
  applicationName: APP_NAME,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: APP_NAME,
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192" }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#131a20" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only-focusable absolute top-2 left-2 z-50 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white"
        >
          Skip to main content
        </a>
        <OfflineBanner />
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}

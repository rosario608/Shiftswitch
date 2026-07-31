"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that caches the app shell and static assets.
 * Schedule data is never served from the cache — see public/sw.js.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // A failed registration only costs offline detection, never correctness.
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}

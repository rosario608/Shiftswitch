import Link from "next/link";
import { WifiOff } from "lucide-react";

export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main id="main" className="mx-auto w-full max-w-md flex-1 px-5 py-16 text-center">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-caution-soft text-caution"
      >
        <WifiOff className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-semibold text-ink">You&rsquo;re offline</h1>
      <p className="mt-3 text-ink-muted">
        Schedule changes require an internet connection. Your schedule and switches will
        load as soon as you&rsquo;re back online.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex min-h-[2.75rem] items-center justify-center rounded-xl bg-brand px-5 font-semibold text-white"
      >
        Try again
      </Link>
    </main>
  );
}

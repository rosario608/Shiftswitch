import Link from "next/link";

/**
 * The public legal pages.
 *
 * They are deliberately outside the authenticated area: both stores require
 * that a privacy policy is reachable at a stable URL by anyone, including a
 * reviewer who has not signed in, and the app links to these URLs from its
 * sign-in screen and its settings.
 */
export default function LegalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-full bg-canvas">
      <header className="border-b border-border-base bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-4">
          <Link href="/" className="text-lg font-bold text-ink">
            ShiftSwitch
          </Link>
          <nav aria-label="Legal" className="flex gap-4 text-sm">
            <Link href="/legal/privacy" className="text-brand-ink underline">
              Privacy
            </Link>
            <Link href="/legal/terms" className="text-brand-ink underline">
              Terms
            </Link>
          </nav>
        </div>
      </header>
      <main
        id="main"
        className="mx-auto max-w-3xl px-5 py-8 [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-ink [&_h3]:mt-5 [&_h3]:mb-1 [&_h3]:font-semibold [&_h3]:text-ink [&_li]:mb-1 [&_p]:mb-3 [&_p]:text-ink-muted [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:text-ink-muted"
      >
        {children}
      </main>
    </div>
  );
}

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { BottomNav } from "@/components/app/bottom-nav";
import { requirePageUser } from "@/server/auth/page-guards";
import { countUnread } from "@/server/domain/notifications";
import { initials } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await requirePageUser();
  const unread = await countUnread(context.user.id);
  const elevated = context.user.role === "chief" || context.user.role === "admin";

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-border-base bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white"
            >
              SS
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink">
                {context.program.name}
              </span>
              <span className="block truncate text-xs text-ink-subtle">
                {context.program.institution}
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            {elevated ? (
              <Link
                href="/admin"
                className="flex min-h-[2.25rem] items-center gap-1.5 rounded-full bg-surface-muted px-3 text-xs font-semibold text-ink-muted"
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {context.user.role === "admin" ? "Admin" : "Chief"}
              </Link>
            ) : null}
            <Link
              href="/profile"
              aria-label="Your profile"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-ink"
            >
              {initials(context.user.fullName || context.user.email)}
            </Link>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 pt-4 pb-28">
        {children}
      </main>

      <BottomNav unreadCount={unread} />
    </div>
  );
}

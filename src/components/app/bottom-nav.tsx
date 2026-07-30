"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  CalendarDays,
  Home,
  Repeat,
  User,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  match: (pathname: string) => boolean;
}

const ITEMS: NavItem[] = [
  { href: "/", label: "Home", Icon: Home, match: (p) => p === "/" },
  {
    href: "/schedule",
    label: "Schedule",
    Icon: CalendarDays,
    match: (p) => p.startsWith("/schedule"),
  },
  {
    href: "/trades",
    label: "Trades",
    Icon: Repeat,
    match: (p) => p.startsWith("/trades") || p.startsWith("/switches"),
  },
  {
    href: "/notifications",
    label: "Alerts",
    Icon: Bell,
    match: (p) => p.startsWith("/notifications"),
  },
  {
    href: "/profile",
    label: "Profile",
    Icon: User,
    match: (p) => p.startsWith("/profile"),
  },
];

export function BottomNav({ unreadCount }: { unreadCount: number }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border-base bg-surface/95 backdrop-blur"
    >
      <ul className="mx-auto flex max-w-3xl items-stretch justify-between px-1 pt-1">
        {ITEMS.map(({ href, label, Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[0.7rem] font-medium",
                  active ? "text-brand-ink" : "text-ink-subtle",
                )}
              >
                <span className="relative">
                  <Icon
                    className="h-6 w-6"
                    aria-hidden="true"
                    strokeWidth={active ? 2.3 : 1.8}
                  />
                  {href === "/notifications" && unreadCount > 0 ? (
                    <span
                      className="absolute -top-1 -right-2 min-w-[1.1rem] rounded-full bg-critical px-1 text-[0.65rem] leading-[1.1rem] font-bold text-white"
                      aria-hidden="true"
                    >
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  ) : null}
                </span>
                {label}
                {href === "/notifications" && unreadCount > 0 ? (
                  <span className="sr-only">{unreadCount} unread</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

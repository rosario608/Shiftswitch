import { NavLink } from "react-router";
import { cx } from "./ui";
import { tapFeedback } from "@/native/shell";

/**
 * The primary navigation. Five destinations at most, each reachable in one
 * tap from anywhere, with the badge count carried on Alerts so a resident
 * knows there is something waiting without opening it.
 */

interface Tab {
  to: string;
  label: string;
  icon: (active: boolean) => React.ReactNode;
  badge?: number;
}

function Icon({ path, active }: { path: string; active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICONS = {
  home: "M3 10.5L12 3l9 7.5M5.5 9.5V20h13V9.5",
  calendar:
    "M7 3v3M17 3v3M3.5 9h17M4.5 5.5h15v15h-15z",
  swap: "M4 8h13l-3.5-3.5M20 16H7l3.5 3.5",
  approvals: "M4.5 12.5l4.5 4.5 10-10M4 20h16",
  bell: "M12 3a6 6 0 00-6 6c0 5-2 6-2 6h16s-2-1-2-6a6 6 0 00-6-6zM10.5 21a2 2 0 003 0",
  person: "M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0",
};

export function TabBar({
  unread,
  showApprovals,
}: {
  unread: number;
  showApprovals: boolean;
}) {
  const tabs: Tab[] = [
    { to: "/", label: "Home", icon: (a) => <Icon path={ICONS.home} active={a} /> },
    {
      to: "/schedule",
      label: "Schedule",
      icon: (a) => <Icon path={ICONS.calendar} active={a} />,
    },
    {
      to: "/switches",
      label: "Switches",
      icon: (a) => <Icon path={ICONS.swap} active={a} />,
    },
    ...(showApprovals
      ? [
          {
            to: "/approvals",
            label: "Approvals",
            icon: (a: boolean) => <Icon path={ICONS.approvals} active={a} />,
          },
        ]
      : []),
    {
      to: "/notifications",
      label: "Alerts",
      icon: (a) => <Icon path={ICONS.bell} active={a} />,
      badge: unread,
    },
    ...(showApprovals
      ? []
      : [
          {
            to: "/profile",
            label: "You",
            icon: (a: boolean) => <Icon path={ICONS.person} active={a} />,
          },
        ]),
  ];

  return (
    <nav
      aria-label="Main"
      className="safe-bottom safe-x border-t border-border-base bg-surface"
    >
      <ul className="flex">
        {tabs.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === "/"}
              onClick={() => void tapFeedback()}
              className={({ isActive }) =>
                cx(
                  "tap flex flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium",
                  isActive ? "text-brand-ink" : "text-ink-subtle",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    {tab.icon(isActive)}
                    {Boolean(tab.badge) && (
                      <span className="absolute -top-1 -right-2 min-w-[18px] rounded-full bg-critical px-1 text-center text-[10px] leading-[18px] font-bold text-white">
                        {tab.badge! > 99 ? "99+" : tab.badge}
                      </span>
                    )}
                  </span>
                  <span>{tab.label}</span>
                  {Boolean(tab.badge) && (
                    <span className="sr-only">
                      {tab.badge} unread notifications
                    </span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

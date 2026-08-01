import Link from "next/link";
import { requirePageCapability } from "@/server/auth/page-guards";
import { can, ROLE_LABEL, type Capability } from "@/server/auth/roles";
import { EnvironmentBadge } from "@/components/app/environment-badge";

export const dynamic = "force-dynamic";

/**
 * The navigation is the permission matrix made visible: each entry names the
 * capability that opens it, and a person only sees what they can actually use.
 * Grouping matters more than it looks — somebody arriving for the first time
 * should be able to find "where do I add a service" without being told, and the
 * only reliable way to do that is to put it next to the other program setup.
 */
interface NavLink {
  href: string;
  label: string;
  /** Any one of these opens it, matching the guard on the page itself. */
  capabilities: [Capability, ...Capability[]];
}

const GROUPS: Array<{ heading: string; links: NavLink[] }> = [
  {
    heading: "Day to day",
    links: [
      { href: "/admin", label: "Overview", capabilities: ["audit.view"] },
      { href: "/admin/scheduler", label: "Scheduler", capabilities: ["scheduling.plan"] },
      { href: "/admin/coverage", label: "Coverage", capabilities: ["scheduling.plan"] },
      { href: "/admin/approvals", label: "Approvals", capabilities: ["approvals.decide"] },
      { href: "/admin/schedule", label: "Program schedule", capabilities: ["schedule.manage"] },
      { href: "/admin/corrections", label: "Corrections", capabilities: ["schedule.manage"] },
      { href: "/admin/import", label: "Import", capabilities: ["schedule.manage"] },
    ],
  },
  {
    heading: "People",
    links: [
      { href: "/admin/roster", label: "Roster", capabilities: ["scheduling.plan"] },
      { href: "/admin/directory", label: "Directory", capabilities: ["residents.contact_info"] },
      { href: "/admin/availability", label: "Availability", capabilities: ["scheduling.plan"] },
      {
        href: "/admin/enrollment",
        label: "Getting people in",
        capabilities: ["invitations.manage"],
      },
      { href: "/admin/users", label: "Users & roles", capabilities: ["users.manage"] },
      { href: "/admin/cohorts", label: "Cohorts & blocks", capabilities: ["scheduling.plan"] },
      { href: "/admin/cycles", label: "Rotation cycles", capabilities: ["scheduling.plan"] },
    ],
  },
  {
    heading: "Program setup",
    links: [
      /* Named for what it is rather than for what it configures. It sat next to
         "Services" as "Set up services", which made two adjacent nav entries
         whose names contained each other — ambiguous to a screen reader, to a
         Playwright locator, and to a coordinator looking for the services
         screen. */
      {
        href: "/admin/setup",
        label: "First-time setup",
        capabilities: ["services.manage"],
      },
      {
        href: "/admin/services",
        label: "Services",
        capabilities: ["services.manage", "scheduling.plan"],
      },
      { href: "/admin/rules", label: "Rules", capabilities: ["rules.manage"] },
      { href: "/admin/contacts", label: "Contacts", capabilities: ["contacts.manage"] },
      { href: "/admin/program", label: "Program settings", capabilities: ["program.manage"] },
    ],
  },
  {
    heading: "Review",
    links: [
      { href: "/admin/analytics", label: "Analytics", capabilities: ["analytics.view"] },
      { href: "/admin/audit", label: "Audit log", capabilities: ["audit.view"] },
      {
        href: "/admin/diagnostics",
        label: "Diagnostics",
        capabilities: ["maintenance.run"],
      },
    ],
  },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await requirePageCapability("audit.view");
  const groups = GROUPS.map((group) => ({
    ...group,
    links: group.links.filter((link) =>
      link.capabilities.some((capability) => can(context.user.role, capability)),
    ),
  })).filter((group) => group.links.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">
          Signed in as <span className="font-semibold text-ink">{ROLE_LABEL[context.user.role]}</span>
        </p>
        <EnvironmentBadge />
      </div>

      <nav aria-label="Administration" className="-mx-4 space-y-2 overflow-x-auto px-4">
        {groups.map((group) => (
          <div key={group.heading}>
            <p className="mb-1 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              {group.heading}
            </p>
            <ul className="flex w-max gap-2 pb-1">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="flex min-h-[2.5rem] items-center rounded-full border border-border-strong px-4 text-sm font-semibold whitespace-nowrap text-ink-muted hover:bg-surface-muted"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {children}
    </div>
  );
}

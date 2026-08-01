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
const GROUPS: Array<{
  heading: string;
  links: Array<{ href: string; label: string; capability: Capability }>;
}> = [
  {
    heading: "Day to day",
    links: [
      { href: "/admin", label: "Overview", capability: "audit.view" },
      { href: "/admin/scheduler", label: "Scheduler", capability: "scheduling.plan" },
      { href: "/admin/approvals", label: "Approvals", capability: "approvals.decide" },
      { href: "/admin/schedule", label: "Schedule", capability: "schedule.manage" },
      { href: "/admin/import", label: "Import", capability: "schedule.manage" },
    ],
  },
  {
    heading: "People",
    links: [
      { href: "/admin/roster", label: "Roster", capability: "scheduling.plan" },
      { href: "/admin/directory", label: "Directory", capability: "residents.contact_info" },
      { href: "/admin/availability", label: "Availability", capability: "scheduling.plan" },
      { href: "/admin/users", label: "Users & roles", capability: "users.manage" },
      { href: "/admin/cohorts", label: "Cohorts & blocks", capability: "scheduling.plan" },
    ],
  },
  {
    heading: "Program setup",
    links: [
      { href: "/admin/services", label: "Services", capability: "services.manage" },
      { href: "/admin/rules", label: "Rules", capability: "rules.manage" },
      { href: "/admin/contacts", label: "Contacts", capability: "contacts.manage" },
      { href: "/admin/program", label: "Program settings", capability: "program.manage" },
    ],
  },
  {
    heading: "Review",
    links: [
      { href: "/admin/analytics", label: "Analytics", capability: "analytics.view" },
      { href: "/admin/audit", label: "Audit log", capability: "audit.view" },
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
    links: group.links.filter((link) => can(context.user.role, link.capability)),
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

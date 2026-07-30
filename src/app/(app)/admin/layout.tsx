import Link from "next/link";
import { requirePageRole } from "@/server/auth/page-guards";

export const dynamic = "force-dynamic";

const LINKS = [
  { href: "/admin", label: "Overview", minRole: "chief" },
  { href: "/admin/approvals", label: "Approvals", minRole: "chief" },
  { href: "/admin/schedule", label: "Schedule", minRole: "chief" },
  { href: "/admin/import", label: "Import", minRole: "chief" },
  { href: "/admin/analytics", label: "Analytics", minRole: "chief" },
  { href: "/admin/audit", label: "Audit", minRole: "chief" },
  { href: "/admin/users", label: "Users", minRole: "admin" },
  { href: "/admin/rules", label: "Rules", minRole: "admin" },
  { href: "/admin/contacts", label: "Contacts", minRole: "admin" },
  { href: "/admin/program", label: "Program", minRole: "admin" },
] as const;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await requirePageRole("chief");
  const links = LINKS.filter(
    (link) => link.minRole !== "admin" || context.user.role === "admin",
  );

  return (
    <div className="space-y-4">
      <nav aria-label="Administration" className="-mx-4 overflow-x-auto px-4">
        <ul className="flex w-max gap-2 pb-1">
          {links.map((link) => (
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
      </nav>
      {children}
    </div>
  );
}

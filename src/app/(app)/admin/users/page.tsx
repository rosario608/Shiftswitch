import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { UserRoleForm } from "@/components/app/admin-actions";
import { requirePageRole } from "@/server/auth/page-guards";
import { listManagedUsers } from "@/server/domain/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const context = await requirePageRole("admin");
  const params = await searchParams;
  const users = await listManagedUsers(context.program.id, {
    includeUnassigned: true,
    search: params.search,
  });
  const unconfigured = users.filter((user) => !user.role);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Users</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {users.length} account{users.length === 1 ? "" : "s"}
          {unconfigured.length > 0
            ? ` · ${unconfigured.length} waiting to be configured`
            : ""}
        </p>
      </header>

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="search"
          defaultValue={params.search ?? ""}
          placeholder="Search by name or email"
          aria-label="Search users"
          className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3 text-base"
        />
        <button
          type="submit"
          className="min-h-[2.75rem] rounded-xl bg-brand px-4 font-semibold text-white"
        >
          Search
        </button>
      </form>

      {users.length === 0 ? (
        <EmptyState title="No users found" description="Try a different search." />
      ) : (
        <ul className="space-y-3">
          {users.map((user) => (
            <li key={user.id}>
              <Card className={user.role ? "" : "border-caution/50"}>
                <CardBody>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{user.full_name}</p>
                      <p className="text-sm text-ink-muted">{user.email}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={user.role ? "brand" : "caution"}>
                        {user.role ?? "Not configured"}
                      </Badge>
                      {user.pgy_level ? (
                        <Badge tone="neutral">PGY-{user.pgy_level}</Badge>
                      ) : null}
                      {!user.active ? <Badge tone="critical">Deactivated</Badge> : null}
                    </div>
                  </div>
                  <UserRoleForm
                    userId={user.id}
                    initialRole={user.role}
                    initialPgy={user.pgy_level}
                    initialActive={user.active}
                    programId={context.program.id}
                  />
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { UserRoleForm } from "@/components/app/admin-actions";
import { InvitationsManager } from "@/components/app/invitations-manager";
import { requirePageCapability } from "@/server/auth/page-guards";
import {
  assignableRoles,
  canAssignRole,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  ROLE_SHORT_LABEL,
} from "@/server/auth/roles";
import { describeEnvironment } from "@/server/config/environment";
import { listManagedUsers } from "@/server/domain/admin";
import { listInvitations } from "@/server/domain/invitations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users & roles" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const context = await requirePageCapability("users.manage");
  const params = await searchParams;
  const users = await listManagedUsers(context.program.id, {
    includeUnassigned: true,
    search: params.search,
  });
  const unconfigured = users.filter((user) => !user.role);
  const invitations = await listInvitations(context.program.id);
  const environment = describeEnvironment();

  /* Only the roles this person may hand out. The server enforces the same rule;
     offering a role that would then be refused is a worse experience than not
     offering it at all. */
  const roleOptions = assignableRoles(context.user.role).map((role) => ({
    value: role,
    label: ROLE_LABEL[role],
    description: ROLE_DESCRIPTION[role],
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Users &amp; roles</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Everyone in {context.program.name}, what they can do, and whether they
          have signed in yet. {users.length} account
          {users.length === 1 ? "" : "s"}
          {unconfigured.length > 0
            ? ` · ${unconfigured.length} waiting to be given a role`
            : ""}
          .
        </p>
      </header>

      {/*
        Invitations sit above the account list because inviting is what somebody
        comes to this screen to do while setting a program up; reviewing existing
        accounts is what they come for every day after.
      */}
      <InvitationsManager
        invitations={invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expires_at: invitation.expires_at.toISOString(),
          send_count: invitation.send_count,
          invited_by_name: invitation.invited_by_name,
          accepted_user_email: invitation.accepted_user_email,
          created_at: invitation.created_at.toISOString(),
        }))}
        roleOptions={roleOptions}
        delivery={{
          enabled: environment.emailDeliveryEnabled,
          reason: environment.emailDeliveryReason,
        }}
        sandbox={environment.invitationSandboxEnabled}
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Accounts</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Somebody appears here once they have accepted an invitation and
            signed in.
          </p>
        </div>

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
          <EmptyState
            title="Nobody here yet"
            description="Invite your residents above. They appear in this list once they accept."
          />
        ) : (
          <ul className="space-y-3">
            {users.map((user) => {
              const isSelf = user.id === context.user.id;
              /* You may edit somebody only if you outrank them — and never
                 yourself, because locking yourself out has no in-app recovery. */
              const editable =
                !isSelf && (!user.role || canAssignRole(context.user.role, user.role));
              return (
                <li key={user.id}>
                  <Card className={user.role ? "" : "border-caution/50"}>
                    <CardBody>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">
                            {user.full_name || user.email}
                            {isSelf && (
                              <span className="ml-2 text-xs font-normal text-ink-subtle">
                                (you)
                              </span>
                            )}
                          </p>
                          <p className="truncate text-sm text-ink-muted">{user.email}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <Badge tone={user.role ? "brand" : "caution"}>
                            {user.role ? ROLE_SHORT_LABEL[user.role] : "Awaiting a role"}
                          </Badge>
                          {user.pgy_level ? (
                            <Badge tone="neutral">PGY-{user.pgy_level}</Badge>
                          ) : null}
                          {!user.active ? (
                            <Badge tone="critical">Deactivated</Badge>
                          ) : null}
                        </div>
                      </div>
                      <UserRoleForm
                        userId={user.id}
                        initialRole={user.role}
                        initialPgy={user.pgy_level}
                        initialActive={user.active}
                        programId={context.program.id}
                        roleOptions={roleOptions}
                        editable={editable}
                        lockedReason={
                          isSelf
                            ? "You cannot change your own role. Ask another administrator or the Program Director."
                            : `${user.role ? ROLE_LABEL[user.role] : "This person"} is at or above your own level, so you cannot change their role.`
                        }
                      />
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

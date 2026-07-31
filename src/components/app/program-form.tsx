"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export function ProgramForm({
  program,
}: {
  program: {
    name: string;
    institution: string;
    timezone: string;
    approvedEmailDomains: string[];
    defaultTradeApprovalRequired: boolean;
  };
}) {
  const router = useRouter();
  const [name, setName] = React.useState(program.name);
  const [institution, setInstitution] = React.useState(program.institution);
  const [timezone, setTimezone] = React.useState(program.timezone);
  const [domains, setDomains] = React.useState(program.approvedEmailDomains.join(", "));
  const [approval, setApproval] = React.useState(program.defaultTradeApprovalRequired);
  const [saved, setSaved] = React.useState(false);

  const save = useAction(
    async () =>
      apiFetch("/api/admin/program", {
        method: "PATCH",
        body: JSON.stringify({
          name,
          institution,
          timezone,
          approvedEmailDomains: domains
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          defaultTradeApprovalRequired: approval,
        }),
      }),
    {
      onSuccess: () => {
        setSaved(true);
        router.refresh();
        setTimeout(() => setSaved(false), 3000);
      },
    },
  );

  return (
    <div>
      {save.error ? (
        <Alert tone="error" className="mb-3">
          {save.error}
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="success" className="mb-3" live>
          Program settings saved.
        </Alert>
      ) : null}

      <Field label="Program name" htmlFor="program-name">
        <Input
          id="program-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Institution" htmlFor="program-institution">
        <Input
          id="program-institution"
          value={institution}
          onChange={(event) => setInstitution(event.target.value)}
        />
      </Field>
      <Field
        label="Timezone"
        htmlFor="program-timezone"
        hint="IANA timezone, e.g. America/New_York. All shift times are displayed in this zone."
      >
        <Input
          id="program-timezone"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
      </Field>
      <Field
        label="Approved email domains"
        htmlFor="program-domains"
        hint="Comma-separated, e.g. hospital.org. Leave empty to allow any verified Google account that an administrator has configured."
      >
        <Input
          id="program-domains"
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
          placeholder="hospital.org"
        />
      </Field>
      <label className="mb-4 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-[var(--brand)]"
          checked={approval}
          onChange={(event) => setApproval(event.target.checked)}
        />
        <span>
          Every switch requires chief approval
          <span className="block text-ink-muted">
            When off, a valid resident-to-resident switch completes immediately unless
            a rule or shift requires approval.
          </span>
        </span>
      </label>

      <Button block loading={save.pending} loadingLabel="Saving…" onClick={() => save.run()}>
        Save program settings
      </Button>
    </div>
  );
}

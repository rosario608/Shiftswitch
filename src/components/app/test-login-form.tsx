"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

const QUICK_ACCOUNTS = [
  { email: "resident01@hospital.org", label: "Resident" },
  { email: "chief@hospital.org", label: "Chief" },
  { email: "admin@hospital.org", label: "Admin" },
];

export function TestLoginForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState(QUICK_ACCOUNTS[0].email);
  const login = useAction(
    async (address: unknown) =>
      apiFetch("/api/auth/test-login", {
        method: "POST",
        body: JSON.stringify({ email: (address as string) ?? email }),
      }),
    {
      onSuccess: () => {
        router.push("/");
        router.refresh();
      },
    },
  );

  return (
    <section className="mt-10 rounded-xl border border-dashed border-border-strong p-4">
      <h2 className="text-sm font-semibold text-ink">Development sign-in</h2>
      <p className="mt-1 mb-3 text-sm text-ink-muted">
        Enabled by <code>ALLOW_TEST_LOGIN</code>. Disabled in production.
      </p>
      {login.error ? (
        <Alert tone="error" className="mb-3">
          {login.error}
        </Alert>
      ) : null}
      <div className="mb-2 flex flex-wrap gap-2">
        {QUICK_ACCOUNTS.map((account) => (
          <Button
            key={account.email}
            size="sm"
            variant="secondary"
            data-testid={`test-login-${account.label.toLowerCase()}`}
            onClick={() => {
              setEmail(account.email);
              login.run(account.email);
            }}
          >
            {account.label}
          </Button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label="Test account email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          inputMode="email"
        />
        <Button
          loading={login.pending}
          loadingLabel="Signing in…"
          onClick={() => login.run(email)}
        >
          Sign in
        </Button>
      </div>
    </section>
  );
}

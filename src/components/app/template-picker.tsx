"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Loading a starting service list.
 *
 * The wording is the feature. A template presented as authoritative is worse
 * than no template, because a coordinator setting a programme up at eleven at
 * night will accept whatever it says and discover in October that the MICU has
 * been asking for the wrong number of people since July. So: "a starting
 * point", "edit every one of them", and an explicit statement that the numbers
 * are guesses.
 *
 * It also never overwrites. Applying twice, or applying after adding services
 * by hand, keeps what is already there and says what it skipped.
 */
interface Template {
  id: string;
  label: string;
  institution: string;
  description: string;
  siteCount: number;
  serviceCount: number;
  services: Array<{ name: string; abbreviation: string; site: string }>;
}

export function TemplatePicker() {
  const router = useRouter();
  const [templates, setTemplates] = React.useState<Template[] | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  const load = useAction(
    async () => {
      const data = await apiFetch<{ templates: Template[] }>("/api/admin/service-templates");
      setTemplates(data.templates);
      return data;
    },
    { onSuccess: () => undefined },
  );

  const apply = useAction(
    async (templateId: string) =>
      apiFetch<{
        sitesCreated: number;
        servicesCreated: number;
        servicesSkipped: string[];
        coverageCreated: number;
      }>("/api/admin/service-templates", {
        method: "POST",
        body: JSON.stringify({ templateId }),
      }),
    {
      onSuccess: (data) => {
        setResult(
          `Added ${data.servicesCreated} service${data.servicesCreated === 1 ? "" : "s"}` +
            `, ${data.sitesCreated} site${data.sitesCreated === 1 ? "" : "s"}` +
            ` and ${data.coverageCreated} coverage rule${data.coverageCreated === 1 ? "" : "s"}.` +
            (data.servicesSkipped.length
              ? ` Left alone because you already have them: ${data.servicesSkipped.join(", ")}.`
              : ""),
        );
        router.refresh();
      },
    },
  );

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <h2 className="font-semibold text-ink">Start from a template</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">
            A service list somebody else typed, as a starting point. Every
            service, staffing number and PGY mix is a guess you should replace —
            they are one programme&rsquo;s answers, not recommendations. Nothing
            you already have is overwritten.
          </p>
        </div>

        {result ? <Alert tone="success">{result}</Alert> : null}
        {apply.error ? <Alert tone="error">{apply.error}</Alert> : null}
        {load.error ? <Alert tone="error">{load.error}</Alert> : null}

        {templates === null ? (
          <Button
            variant="secondary"
            loading={load.pending}
            loadingLabel="Loading…"
            onClick={() => load.run()}
          >
            See the available templates
          </Button>
        ) : templates.length === 0 ? (
          <p className="text-sm text-ink-muted">No templates are available.</p>
        ) : (
          <ul className="space-y-2">
            {templates.map((template) => (
              <li key={template.id} className="rounded-xl border border-border-base p-3">
                <p className="font-semibold text-ink">{template.label}</p>
                <p className="text-sm text-ink-subtle">{template.institution}</p>
                <p className="mt-1 text-sm text-ink-muted">{template.description}</p>
                <p className="mt-1 text-sm text-ink-subtle">
                  {template.serviceCount} services across {template.siteCount} sites
                </p>

                <button
                  type="button"
                  className="mt-2 text-sm font-semibold text-brand"
                  onClick={() =>
                    setExpanded(expanded === template.id ? null : template.id)
                  }
                >
                  {expanded === template.id ? "Hide the list" : "See what it adds"}
                </button>

                {expanded === template.id ? (
                  <ul className="mt-2 space-y-0.5 text-sm text-ink-muted">
                    {template.services.map((service) => (
                      <li key={service.name}>
                        {service.name}{" "}
                        <span className="text-ink-subtle">· {service.site}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="mt-3">
                  <Button
                    size="sm"
                    loading={apply.pending}
                    loadingLabel="Adding…"
                    onClick={() => apply.run(template.id)}
                  >
                    Add these, then edit them
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

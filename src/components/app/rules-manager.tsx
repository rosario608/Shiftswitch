"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export interface RuleRecord {
  id: string;
  rule_type: string;
  name: string;
  description: string;
  params: Record<string, unknown>;
  severity: "error" | "warning";
  scope: string;
  scope_id: string | null;
  overridable: boolean;
  active: boolean;
  summary: string;
  categoryLabel: string;
}

export interface RuleTypeOption {
  type: string;
  label: string;
  description: string;
  category: number;
}

/**
 * Rules are stored as `(type, params)` pairs, so this editor works for every
 * rule type — including ones added later — without code changes here.
 */
export function RulesManager({
  rules,
  ruleTypes,
  services,
}: {
  rules: RuleRecord[];
  ruleTypes: RuleTypeOption[];
  services: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<RuleRecord | null>(null);

  const toggle = useAction(
    async (payload: unknown) => {
      const { id, active } = payload as { id: string; active: boolean };
      return apiFetch(`/api/admin/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
    },
    { onSuccess: () => router.refresh() },
  );

  return (
    <div className="space-y-4">
      {toggle.error ? <Alert tone="error">{toggle.error}</Alert> : null}

      <Button block onClick={() => setCreating(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add a rule
      </Button>

      <ul className="space-y-3">
        {rules.map((rule) => (
          <li key={rule.id}>
            <Card className={rule.active ? "" : "opacity-70"}>
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{rule.name}</p>
                    <p className="mt-0.5 text-sm text-ink-muted">{rule.summary}</p>
                    {rule.description ? (
                      <p className="mt-1 text-sm text-ink-subtle">{rule.description}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone="neutral">{rule.categoryLabel}</Badge>
                      <Badge tone={rule.severity === "error" ? "critical" : "caution"}>
                        {rule.severity === "error" ? "Blocks trades" : "Warning only"}
                      </Badge>
                      {rule.scope !== "program" ? (
                        <Badge tone="neutral">Scoped to {rule.scope}</Badge>
                      ) : null}
                      {!rule.overridable ? (
                        <Badge tone="neutral">Cannot be overridden</Badge>
                      ) : null}
                      {!rule.active ? <Badge tone="neutral">Inactive</Badge> : null}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(rule)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => toggle.run({ id: rule.id, active: !rule.active })}
                  >
                    {rule.active ? "Disable" : "Enable"}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>

      {/* `key` remounts the sheet so its fields start from the chosen rule —
          no state syncing effect required. */}
      {creating ? (
        <RuleSheet
          key="new-rule"
          open
          onClose={() => setCreating(false)}
          ruleTypes={ruleTypes}
          services={services}
        />
      ) : null}
      {editing ? (
        <RuleSheet
          key={editing.id}
          open
          onClose={() => setEditing(null)}
          ruleTypes={ruleTypes}
          services={services}
          rule={editing}
        />
      ) : null}
    </div>
  );
}

function RuleSheet({
  open,
  onClose,
  ruleTypes,
  services,
  rule,
}: {
  open: boolean;
  onClose: () => void;
  ruleTypes: RuleTypeOption[];
  services: Array<{ id: string; name: string }>;
  rule?: RuleRecord | null;
}) {
  const router = useRouter();
  const [ruleType, setRuleType] = React.useState(rule?.rule_type ?? ruleTypes[0]?.type ?? "");
  const [name, setName] = React.useState(rule?.name ?? "");
  const [description, setDescription] = React.useState(rule?.description ?? "");
  const [params, setParams] = React.useState(
    JSON.stringify(rule?.params ?? {}, null, 2),
  );
  const [severity, setSeverity] = React.useState(rule?.severity ?? "error");
  const [scope, setScope] = React.useState(rule?.scope ?? "program");
  const [scopeId, setScopeId] = React.useState(rule?.scope_id ?? "");
  const [overridable, setOverridable] = React.useState(rule?.overridable ?? true);
  const [paramsError, setParamsError] = React.useState<string | null>(null);

  const save = useAction(
    async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(params || "{}");
      } catch {
        setParamsError("Settings must be valid JSON.");
        throw new Error("invalid json");
      }
      const body = {
        ruleType,
        name,
        description,
        params: parsed,
        severity,
        scope,
        scopeId: scope === "program" ? null : scopeId || null,
        overridable,
        active: rule?.active ?? true,
      };
      return rule
        ? apiFetch(`/api/admin/rules/${rule.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : apiFetch("/api/admin/rules", { method: "POST", body: JSON.stringify(body) });
    },
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  const remove = useAction(
    async () => apiFetch(`/api/admin/rules/${rule?.id}`, { method: "DELETE" }),
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  const selectedType = ruleTypes.find((option) => option.type === ruleType);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={rule ? "Edit rule" : "Add a rule"}
      description={selectedType?.description}
      footer={
        <div className="flex gap-2 pb-2">
          <Button variant="secondary" block onClick={onClose}>
            Cancel
          </Button>
          <Button
            block
            loading={save.pending}
            loadingLabel="Saving…"
            disabled={!name.trim()}
            onClick={() => save.run()}
          >
            Save rule
          </Button>
        </div>
      }
    >
      {save.error && save.error !== "invalid json" ? (
        <Alert tone="error" className="mb-3">
          {save.error}
        </Alert>
      ) : null}

      <Field label="Rule type" htmlFor="rule-type">
        <Select
          id="rule-type"
          value={ruleType}
          disabled={Boolean(rule)}
          onChange={(event) => setRuleType(event.target.value)}
        >
          {ruleTypes.map((option) => (
            <option key={option.type} value={option.type}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Name" htmlFor="rule-name">
        <Input
          id="rule-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={selectedType?.label}
        />
      </Field>

      <Field label="Description" htmlFor="rule-description">
        <Textarea
          id="rule-description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <Field
        label="Settings (JSON)"
        htmlFor="rule-params"
        hint='For example: {"hours": 10}'
        error={paramsError}
      >
        <Textarea
          id="rule-params"
          rows={5}
          className="font-mono text-sm"
          value={params}
          onChange={(event) => {
            setParams(event.target.value);
            setParamsError(null);
          }}
        />
      </Field>

      <Field label="Severity" htmlFor="rule-severity">
        <Select
          id="rule-severity"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as "error" | "warning")}
        >
          <option value="error">Blocks the trade</option>
          <option value="warning">Warning only</option>
        </Select>
      </Field>

      <Field label="Applies to" htmlFor="rule-scope">
        <Select
          id="rule-scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="program">The whole program</option>
          <option value="service">One service</option>
        </Select>
      </Field>

      {scope === "service" ? (
        <Field label="Service" htmlFor="rule-scope-id">
          <Select
            id="rule-scope-id"
            value={scopeId}
            onChange={(event) => setScopeId(event.target.value)}
          >
            <option value="">Choose a service…</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <label className="mb-4 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--brand)]"
          checked={overridable}
          onChange={(event) => setOverridable(event.target.checked)}
        />
        A chief resident may override this rule (with a recorded reason)
      </label>

      {rule ? (
        <Button
          variant="danger"
          block
          loading={remove.pending}
          loadingLabel="Deleting…"
          onClick={() => remove.run()}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete rule
        </Button>
      ) : null}
    </Sheet>
  );
}

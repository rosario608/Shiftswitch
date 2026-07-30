"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export interface ContactRecord {
  id: string;
  name: string;
  email: string;
  contact_type: string;
  notify_role: string;
  active: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  program_coordinator: "Program coordinator",
  chief_resident: "Chief resident",
  associate_program_director: "Associate program director",
  program_director: "Program director",
  other: "Other",
};

const ROLE_LABEL: Record<string, string> = {
  to: "To",
  cc: "Cc",
  none: "Not notified",
};

/** Program contacts drive the recipients of the completed-switch email. */
export function ContactsManager({ contacts }: { contacts: ContactRecord[] }) {
  const [editing, setEditing] = React.useState<ContactRecord | null>(null);
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="space-y-4">
      <Button block onClick={() => setCreating(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add a contact
      </Button>

      <ul className="space-y-3">
        {contacts.map((contact) => (
          <li key={contact.id}>
            <Card className={contact.active ? "" : "opacity-70"}>
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{contact.name}</p>
                    <p className="text-sm text-ink-muted">{contact.email}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone="neutral">
                        {TYPE_LABEL[contact.contact_type] ?? contact.contact_type}
                      </Badge>
                      <Badge tone={contact.notify_role === "none" ? "neutral" : "brand"}>
                        {ROLE_LABEL[contact.notify_role]}
                      </Badge>
                      {!contact.active ? <Badge tone="neutral">Inactive</Badge> : null}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(contact)}>
                    Edit
                  </Button>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>

      <ContactSheet open={creating} onClose={() => setCreating(false)} />
      <ContactSheet
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        contact={editing}
      />
    </div>
  );
}

function ContactSheet({
  open,
  onClose,
  contact,
}: {
  open: boolean;
  onClose: () => void;
  contact?: ContactRecord | null;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(contact?.name ?? "");
  const [email, setEmail] = React.useState(contact?.email ?? "");
  const [contactType, setContactType] = React.useState(
    contact?.contact_type ?? "program_coordinator",
  );
  const [notifyRole, setNotifyRole] = React.useState(contact?.notify_role ?? "to");
  const [active, setActive] = React.useState(contact?.active ?? true);

  React.useEffect(() => {
    if (!open) return;
    setName(contact?.name ?? "");
    setEmail(contact?.email ?? "");
    setContactType(contact?.contact_type ?? "program_coordinator");
    setNotifyRole(contact?.notify_role ?? "to");
    setActive(contact?.active ?? true);
  }, [open, contact]);

  const save = useAction(
    async () => {
      const body = { name, email, contactType, notifyRole, active };
      return contact
        ? apiFetch(`/api/admin/contacts/${contact.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : apiFetch("/api/admin/contacts", { method: "POST", body: JSON.stringify(body) });
    },
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  const remove = useAction(
    async () => apiFetch(`/api/admin/contacts/${contact?.id}`, { method: "DELETE" }),
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={contact ? "Edit contact" : "Add a contact"}
      description="Contacts marked “To” or “Cc” are pre-filled on the completed-switch email."
      footer={
        <div className="flex gap-2 pb-2">
          <Button variant="secondary" block onClick={onClose}>
            Cancel
          </Button>
          <Button
            block
            loading={save.pending}
            loadingLabel="Saving…"
            disabled={!name.trim() || !email.trim()}
            onClick={() => save.run()}
          >
            Save contact
          </Button>
        </div>
      }
    >
      {save.error ? (
        <Alert tone="error" className="mb-3">
          {save.error}
        </Alert>
      ) : null}

      <Field label="Name" htmlFor="contact-name">
        <Input
          id="contact-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Email" htmlFor="contact-email">
        <Input
          id="contact-email"
          type="email"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field label="Role" htmlFor="contact-type">
        <Select
          id="contact-type"
          value={contactType}
          onChange={(event) => setContactType(event.target.value)}
        >
          {Object.entries(TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Include on switch emails as" htmlFor="contact-notify">
        <Select
          id="contact-notify"
          value={notifyRole}
          onChange={(event) => setNotifyRole(event.target.value)}
        >
          <option value="to">To</option>
          <option value="cc">Cc</option>
          <option value="none">Do not include</option>
        </Select>
      </Field>
      <label className="mb-4 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--brand)]"
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
        />
        Active
      </label>

      {contact ? (
        <Button
          variant="danger"
          block
          loading={remove.pending}
          loadingLabel="Deleting…"
          onClick={() => remove.run()}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete contact
        </Button>
      ) : null}
    </Sheet>
  );
}

import { ContactsManager } from "@/components/app/contacts-manager";
import { requirePageCapability } from "@/server/auth/page-guards";
import { listProgramContacts } from "@/server/domain/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Program contacts" };

export default async function ContactsPage() {
  const context = await requirePageCapability("contacts.manage");
  const contacts = await listProgramContacts(context.program.id);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Program contacts</h1>
        <p className="mt-1 text-sm text-ink-muted">
          These addresses are pre-filled when a resident notifies the program about a
          completed switch.
        </p>
      </header>
      <ContactsManager
        contacts={contacts.map((contact) => ({
          id: contact.id,
          name: contact.name,
          email: contact.email,
          contact_type: contact.contact_type,
          notify_role: contact.notify_role,
          active: contact.active,
        }))}
      />
    </div>
  );
}

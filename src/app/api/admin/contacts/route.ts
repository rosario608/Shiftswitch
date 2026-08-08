import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { contactSchema } from "@/lib/schemas";
import { createContact } from "@/server/domain/admin";
import { listProgramContacts } from "@/server/domain/email";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireCapability("contacts.manage");
  const contacts = await listProgramContacts(context.program.id);
  return ok({ contacts });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("contacts.manage");
  const input = await parseJson(request, contactSchema);
  const contact = await createContact(context, input);
  return ok({ contact }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;

import { requireChief } from "@/server/auth/guards";
import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { contactSchema } from "@/lib/schemas";
import { createContact } from "@/server/domain/admin";
import { listProgramContacts } from "@/server/domain/email";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireChief();
  const contacts = await listProgramContacts(context.program.id);
  return ok({ contacts });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireAdmin();
  const input = await parseJson(request, contactSchema);
  const contact = await createContact(context, input);
  return ok({ contact }, { status: 201 });
});

import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { createEnrollmentLink, listEnrollmentLinks } from "@/server/domain/enrollment";

export const dynamic = "force-dynamic";

/**
 * Enrollment links are part of getting people into the program, so they need
 * the same capability as invitations. Nothing here lets somebody hand out a
 * link more powerful than the account they signed in with: a link only ever
 * grants `resident`, enforced in `createEnrollmentLink` rather than here, so
 * every caller gets the same answer.
 */

export const GET = apiHandler(async () => {
  const context = await requireCapability("invitations.manage");
  return ok({ links: await listEnrollmentLinks(context.program.id) });
});

const createSchema = z.object({
  label: z.string().max(120).optional(),
  expiresInDays: z.number().int().min(1).max(180).optional(),
  maxUses: z.number().int().min(1).max(2000).nullable().optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("invitations.manage");
  const input = await parseJson(request, createSchema);
  const created = await createEnrollmentLink(context, input);
  /* The raw token exists exactly once, here. Whoever asked for it has to copy
     it now — there is no screen that can show it again, because only its hash
     was stored. */
  return ok(
    { id: created.link.id, url: created.url, expiresAt: created.link.expires_at },
    { status: 201 },
  );
});

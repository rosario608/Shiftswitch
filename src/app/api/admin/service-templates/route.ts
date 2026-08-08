import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { SERVICE_TEMPLATES, applyServiceTemplate } from "@/server/domain/service-templates";

export const dynamic = "force-dynamic";

const applySchema = z.object({ templateId: z.string().min(1).max(80) });

/** The catalogue, without the coverage detail — enough to choose from. */
export const GET = apiHandler(async () => {
  await requireCapability("services.manage");
  return ok({
    templates: SERVICE_TEMPLATES.map((template) => ({
      id: template.id,
      label: template.label,
      institution: template.institution,
      description: template.description,
      siteCount: template.sites.length,
      serviceCount: template.services.length,
      services: template.services.map((service) => ({
        name: service.name,
        abbreviation: service.abbreviation,
        site: service.site,
      })),
    })),
  });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("services.manage");
  const { templateId } = await parseJson(request, applySchema);
  const result = await applyServiceTemplate(context, templateId);
  return ok(result, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;

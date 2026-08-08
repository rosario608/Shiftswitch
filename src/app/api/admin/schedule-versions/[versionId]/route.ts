import { z } from "zod";
import { requireCapability, requireUser } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { notFound } from "@/server/http/errors";
import { loadScheduleSnapshot } from "@/server/domain/constraints/snapshot";
import { validateSchedule } from "@/server/domain/constraints/validator";
import { localDateString } from "@/server/domain/time";
import {
  approveScheduleVersion,
  diffScheduleVersion,
  discardScheduleVersion,
  getScheduleVersion,
  publishScheduleVersion,
  withdrawApproval,
} from "@/server/domain/schedule-versions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ versionId: string }> };

const actionSchema = z.object({
  action: z.enum(["publish", "diff", "approve", "withdraw-approval"]),
  /** Publishing over live switches is deliberate and audited, never a default. */
  force: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const diff = await diffScheduleVersion(
    context.program.id,
    versionId,
    context.program.timezone,
  );
  return ok({ diff });
});

export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { versionId } = await params;
  /* Which capability this needs depends on the action, so the body has to be
     read before the real guard runs. That is fine for anybody signed in and
     wrong for anybody who is not: it answered an unauthenticated caller with
     422 and the request schema rather than 401. Establishing *a* session first
     costs one lookup and changes no authorisation — the per-action checks below
     are untouched. */
  await requireUser();
  const input = await parseJson(request, actionSchema);

  if (input.action === "diff") {
    const context = await requireCapability("scheduling.plan");
    const diff = await diffScheduleVersion(
      context.program.id,
      versionId,
      context.program.timezone,
    );
    return ok({ diff });
  }

  /* Everything past this point changes what residents work, so it is guarded
     by `schedule.publish` rather than `scheduling.plan`. Building a schedule
     and putting one into people's lives are different authorities. */
  const context = await requireCapability("schedule.publish");

  if (input.action === "withdraw-approval") {
    const version = await withdrawApproval(context, versionId);
    return ok({ version });
  }

  if (input.action === "approve") {
    const existing = await getScheduleVersion(context.program.id, versionId);
    if (!existing) throw notFound("That draft schedule no longer exists.");

    /* Validated here rather than trusting a number the client sends. What is
       recorded has to be what the schedule *is* at the moment of approval —
       an approval carrying a score the browser computed ten minutes and three
       edits ago is a signature on a document nobody read. */
    const snapshot = await loadScheduleSnapshot(
      {
        id: context.program.id,
        name: context.program.name,
        timezone: context.program.timezone,
      },
      {
        period: {
          start: localDateString(existing.period_start, "UTC"),
          end: localDateString(existing.period_end, "UTC"),
        },
        versionId,
        withBaseline: true,
      },
    );
    const validation = validateSchedule(snapshot);
    const hard = validation.violations.filter((v) => v.kind === "hard");

    const version = await approveScheduleVersion(context, versionId, {
      notes: input.notes,
      report: {
        score: validation.score.score,
        hard: hard.length,
        soft: validation.violations.length - hard.length,
        shifts: existing.shift_count,
        /* Capped. The point is a record of what was accepted, and thirty
           sentences serve that; three hundred is a blob nobody opens. */
        accepted: hard.slice(0, 30).map((violation) => violation.message),
      },
    });
    return ok({ version, validation });
  }

  const result = await publishScheduleVersion(context, versionId, { force: input.force });
  return ok(result);
});

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  await discardScheduleVersion(context, versionId);
  return ok({ discarded: true });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;

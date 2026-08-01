import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import {
  createBlockStructure,
  generateBlocks,
  listBlockStructures,
} from "@/server/domain/blocks";

export const dynamic = "force-dynamic";

/**
 * Blocks are either generated from a pattern or listed explicitly.
 *
 * The generated form is the common case and the one that makes "4+4 is
 * configuration" true: `weeks` and `kinds` are arguments, so a two-week
 * structure or a thirteen-block year is the same request with different
 * numbers. The explicit form exists because every programme has at least one
 * block that does not fit the pattern.
 */
const createSchema = z.object({
  name: z.string().min(1).max(120),
  academicYear: z.number().int().min(1900).max(2200),
  description: z.string().max(2000).optional(),
  generate: z
    .object({
      startDate: z.string().date(),
      weeks: z.number().int().min(1).max(52),
      count: z.number().int().min(1).max(60),
      kinds: z.array(z.string().max(60)).max(6).optional(),
      labelPrefix: z.string().max(40).optional(),
    })
    .optional(),
  blocks: z
    .array(
      z.object({
        sequence: z.number().int().min(1),
        label: z.string().min(1).max(120),
        startDate: z.string().date(),
        endDate: z.string().date(),
        kind: z.string().max(60).optional(),
        notes: z.string().max(500).optional(),
      }),
    )
    .max(60)
    .optional(),
});

export const GET = apiHandler(async () => {
  const context = await requireCapability("scheduling.plan");
  const structures = await listBlockStructures(context.program.id);
  return ok({ structures });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("scheduling.plan");
  const input = await parseJson(request, createSchema);
  const blocks = input.generate ? generateBlocks(input.generate) : (input.blocks ?? []);
  const structure = await createBlockStructure(context, {
    name: input.name,
    academicYear: input.academicYear,
    description: input.description,
    blocks,
  });
  return ok({ structure }, { status: 201 });
});

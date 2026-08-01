import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { commitImport } from "@/server/domain/import";
import { markCommitted, rowsForCommit } from "@/server/domain/assisted-import/store";

export const dynamic = "force-dynamic";

/**
 * Turning a reviewed proposal into a schedule.
 *
 * ## Everything that makes this safe is somewhere else
 *
 * The rows come from `rowsForCommit`, which reads the confidences and the
 * review marks out of the database and refuses while anything flagged is still
 * unread. They then go through `validateImport` and `commitImport` — the same
 * two functions a hand-typed CSV goes through, in the same order, with the same
 * all-or-nothing transaction and the same idempotent re-import.
 *
 * There is deliberately no separate write path for extracted rows. A second
 * writer is how the two would drift, and the one that drifted would be the one
 * with a model behind it.
 *
 * The request carries no rows. It cannot: the point of storing the proposal is
 * that what gets committed is what was reviewed, not what a client says was.
 */
export const POST = apiHandler(
  async (_request: Request, route: { params: Promise<{ id: string }> }) => {
    const context = await requireCapability("schedule.manage");
    const { id } = await route.params;

    const { rows } = await rowsForCommit(context.program.id, id);

    /* `commitImport` re-validates from these rows and refuses the whole file if
       any row is malformed — which is a different question from whether it was
       reviewed. A reviewer can confirm that a cell really does say "Feb 30";
       that makes the extraction faithful and the shift still impossible. */
    const result = await commitImport(context, rows);
    await markCommitted(id);
    return ok({ result });
  },
);

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ShiftEntry } from "@/components/app/shift-entry";
import { requirePageCapability } from "@/server/auth/page-guards";
import { listServices } from "@/server/domain/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "Add my shifts" };

/**
 * Where a resident says what they are working.
 *
 * Reachable by anybody with a schedule, including an account still waiting to
 * be confirmed — which is deliberate and is the point of `shifts.self_report`
 * being its own capability. Somebody who joined this morning with a personal
 * address can put their week in and use the product today; what they cannot do
 * is see anybody else's.
 */
export default async function AddShiftsPage() {
  const context = await requirePageCapability("shifts.self_report");
  const services = await listServices(context.program.id);

  return (
    <div className="space-y-5">
      <Link
        href="/schedule"
        className="inline-flex items-center gap-1 text-sm font-medium text-ink-muted"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        My schedule
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-ink">Add my shifts</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Set the pattern once, then tap the days. Times are in{" "}
          {context.program.timezone}.
        </p>
      </header>

      <ShiftEntry services={services.map((service) => service.name)} />
    </div>
  );
}

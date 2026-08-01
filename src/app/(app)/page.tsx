import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeading } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ShiftCard } from "@/components/app/shift-card";
import { AdHocPostButton } from "@/components/app/ad-hoc-post-sheet";
import { PostShiftButton } from "@/components/app/post-shift-sheet";
import { OfferDecisionList, type OfferView } from "@/components/app/offer-decision";
import { requirePageUser } from "@/server/auth/page-guards";
import { getResidentDashboard } from "@/server/domain/dashboard";
import { listOfferableForPosting } from "@/server/domain/schedule-actions";
import { listServices } from "@/server/domain/services";
import { toShiftView } from "@/lib/views";
import { fmtRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The first ten seconds.
 *
 * Two questions, both answered before anything is tapped: **what am I working
 * next**, and **does anything need me**. Everything else on this screen sits
 * below those two and can be scrolled to.
 *
 * ## What changed, and why
 *
 * The screen used to open with "Hello, Alice" and a sentence describing itself
 * — two lines of the most valuable space on a phone, spent on neither question.
 * The heading is now the *answer*: "Needs you" when something does, "Next
 * shift" when nothing does, "No upcoming shifts" when there is nothing at all.
 * A resident opening the app at 3am reads one line and knows.
 *
 * A single waiting offer is decided **here**, not on another screen: one offer
 * is a yes-or-no, and making somebody navigate to answer it spends a tap on
 * transport rather than on the decision. Several offers still link out, because
 * choosing between them is a comparison and the switch screen is built for it.
 *
 * The old "Quick actions" card at the bottom is gone. Three links, two of which
 * duplicated the bottom navigation and one of which duplicated the button on
 * the shift card directly above it.
 */
export default async function HomePage() {
  const context = await requirePageUser();
  const timezone = context.program.timezone;
  const dashboard = await getResidentDashboard(context);
  const postable = context.resident
    ? await listOfferableForPosting(context.resident.id)
    : [];
  /* Only read when there is nothing to show, which is the only branch that
     offers naming a shift. A programme with a schedule does not pay for this. */
  const serviceNames =
    context.resident && !dashboard.nextShift
      ? (await listServices(context.program.id)).map((service) => service.name)
      : [];

  const needsYou = dashboard.pendingActions.length > 0;
  const heading = needsYou
    ? "Needs you"
    : dashboard.nextShift
      ? "Next shift"
      : "No upcoming shifts";

  return (
    <div className="space-y-7">
      <h1 className="text-2xl font-semibold text-ink">{heading}</h1>

      {needsYou ? (
        <section aria-label="Needs you" className="-mt-3">
          <ul className="space-y-2">
            {dashboard.pendingActions.map((action) => {
              if (action.decide) {
                const offer = action.decide.offer;
                const snapshot = offer.validation_snapshot as
                  | { requiresApproval?: boolean }
                  | null;
                const view: OfferView = {
                  id: offer.id,
                  status: offer.status,
                  offeringResidentName: offer.offering_resident_name,
                  offeringResidentPgy: offer.offering_resident_pgy,
                  offeredShift: toShiftView(offer.offered_shift, timezone),
                  matchScore: null,
                  requiresApproval: Boolean(snapshot?.requiresApproval),
                  expiresLabel: fmtRelative(offer.expires_at),
                };
                return (
                  <li key={action.id}>
                    {/* The decision, in place. The confirmation that spells out
                        what you give and what you receive lives inside
                        `OfferDecisionList` and is not skipped here — this
                        removes the trip to another screen, not the safeguard. */}
                    <OfferDecisionList
                      offers={[view]}
                      sourceShift={toShiftView(action.decide.sourceShift, timezone)}
                      requiresApproval={action.decide.requiresApproval}
                    />
                    <Link
                      href={action.href}
                      className="mt-1.5 inline-flex min-h-[2.5rem] items-center gap-1 px-1 text-sm font-semibold text-brand-ink"
                    >
                      {action.cta}
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </li>
                );
              }
              return (
                <li key={action.id}>
                  <Card className="border-caution/40">
                    <Link
                      href={action.href}
                      className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-muted"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-ink">
                          {action.title}
                        </span>
                        <span className="mt-0.5 block text-sm text-ink-muted">
                          {action.detail}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-ink">
                        {action.cta}
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                      </span>
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="next-shift-heading">
        {/* Only given a visible heading when it is not already the page
            heading, so a screen reader does not hear "Next shift" twice. */}
        {needsYou ? (
          <SectionHeading id="next-shift-heading" title="Next shift" />
        ) : (
          <span id="next-shift-heading" className="sr-only">
            Next shift
          </span>
        )}
        {dashboard.nextShift ? (
          <ShiftCard
            shift={toShiftView(dashboard.nextShift, timezone)}
            emphasis
            action={
              context.resident ? (
                <PostShiftButton
                  shifts={postable.map((shift) => toShiftView(shift, timezone))}
                  preselectedShiftId={dashboard.nextShift.id}
                  label="Post this shift"
                  disabledReason={
                    dashboard.nextShift.status !== "scheduled"
                      ? "This shift is already part of a switch."
                      : !dashboard.nextShift.tradeable
                        ? "Your program does not allow this shift to be switched."
                        : null
                  }
                />
              ) : null
            }
          />
        ) : (
          /* The teaching empty state, and the one place the marketplace has to
             stand on its own. A resident whose programme has uploaded nothing
             used to be told to wait for it — which is a dead end wearing the
             clothes of an explanation, and it arrives at the exact moment they
             are deciding whether this product is worth keeping. They can name
             the shift instead. */
          <EmptyState
            title="Nothing on your schedule yet"
            description="You don't have to wait for your program to upload anything. Name the shift you need covered and it goes up for switch now."
            action={
              context.resident ? (
                <div className="w-full max-w-xs">
                  <AdHocPostButton services={serviceNames} />
                </div>
              ) : null
            }
          />
        )}
      </section>

      {dashboard.upcoming.length > 0 ? (
        <section aria-labelledby="upcoming-heading">
          <SectionHeading
            id="upcoming-heading"
            title="After that"
            action={
              <Link
                href="/schedule"
                className="flex items-center gap-1 text-sm font-semibold text-brand-ink"
              >
                Full schedule
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            }
          />
          <ul className="space-y-2">
            {dashboard.upcoming.map((shift) => (
              <li key={shift.id}>
                <ShiftCard shift={toShiftView(shift, timezone)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="available-heading">
        <SectionHeading
          id="available-heading"
          title="Shifts you can take"
          action={
            <Link
              href="/switches"
              className="flex items-center gap-1 text-sm font-semibold text-brand-ink"
            >
              See all
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          }
        />
        {dashboard.availableTrades.length === 0 ? (
          <EmptyState
            title="Nobody has posted a shift"
            description="When a colleague posts one you could take it shows up here, best match first. You can post one of yours from the card above."
          />
        ) : (
          <ul className="space-y-2">
            {dashboard.availableTrades.slice(0, 3).map((trade) => {
              const view = toShiftView(trade.shift, timezone);
              return (
                <li key={trade.id}>
                  <Card>
                    <Link
                      href={`/switches/${trade.id}`}
                      className="block px-4 py-3.5 hover:bg-surface-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">
                            {view.dayLabel} · {view.serviceName}
                          </p>
                          <p className="mt-0.5 text-sm text-ink-muted">
                            {view.timeRange} · {trade.initiator_name} (PGY-
                            {trade.initiator_pgy})
                          </p>
                        </div>
                        {trade.my_offer_id ? (
                          <Badge tone="brand">You offered</Badge>
                        ) : (
                          <ChevronRight
                            className="mt-1 h-5 w-5 shrink-0 text-ink-subtle"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

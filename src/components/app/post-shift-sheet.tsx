"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Info } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction, useOnline } from "@/lib/use-action";
import type { ShiftView } from "@/lib/views";

/**
 * "Post for trade" in one sheet: choose one of your eligible shifts, optionally
 * describe what you'd like back, and post. Restrictions are explained before
 * the resident commits to anything.
 */
export function PostShiftButton({
  shifts,
  preselectedShiftId,
  label = "Post for trade",
  variant = "primary",
  icon,
  disabledReason,
}: {
  shifts: ShiftView[];
  preselectedShiftId?: string;
  label?: string;
  variant?: "primary" | "secondary";
  icon?: React.ReactNode;
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const online = useOnline();
  const [open, setOpen] = React.useState(false);
  const [shiftId, setShiftId] = React.useState(
    preselectedShiftId && shifts.some((shift) => shift.id === preselectedShiftId)
      ? preselectedShiftId
      : (shifts[0]?.id ?? ""),
  );
  const [notes, setNotes] = React.useState("");
  const [preferredDates, setPreferredDates] = React.useState("");
  const [preferredTypes, setPreferredTypes] = React.useState<string[]>([]);

  const selected = shifts.find((shift) => shift.id === shiftId) ?? null;

  const post = useAction(
    async () => {
      const dates = preferredDates
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
      return apiFetch<{ tradeRequest: { id: string } }>("/api/trades", {
        method: "POST",
        body: JSON.stringify({
          shiftId,
          notes: notes.trim() || undefined,
          preferences: {
            preferredDates: dates,
            preferredShiftTypes: preferredTypes,
            preferredServiceIds: [],
          },
        }),
      });
    },
    {
      onSuccess: (result) => {
        setOpen(false);
        setNotes("");
        setPreferredDates("");
        router.push(`/trades/${result.tradeRequest.id}`);
        router.refresh();
      },
    },
  );

  const noShifts = shifts.length === 0;

  return (
    <>
      <Button
        variant={variant}
        block
        onClick={() => setOpen(true)}
        disabled={Boolean(disabledReason) || noShifts}
      >
        {icon ?? <CalendarPlus className="h-4 w-4" aria-hidden="true" />}
        {label}
      </Button>
      {disabledReason ? (
        <p className="mt-2 text-center text-sm text-ink-muted">{disabledReason}</p>
      ) : null}
      {!disabledReason && noShifts ? (
        <p className="mt-2 text-center text-sm text-ink-muted">
          You have no shifts that can be posted right now.
        </p>
      ) : null}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Post a shift for trade"
        description="Other residents in your program will be able to offer one of their shifts."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" onClick={() => setOpen(false)} block>
              Cancel
            </Button>
            <Button
              block
              loading={post.pending}
              loadingLabel="Posting…"
              disabled={!shiftId || !online}
              onClick={() => post.run()}
            >
              Post for trade
            </Button>
          </div>
        }
      >
        {post.error ? (
          <Alert tone="error" className="mb-4">
            {post.error}
          </Alert>
        ) : null}
        {!online ? (
          <Alert tone="warning" className="mb-4">
            You&rsquo;re offline. Schedule changes require an internet connection.
          </Alert>
        ) : null}

        <fieldset className="mb-5">
          <legend className="mb-2 block text-sm font-medium text-ink">
            Which shift?
          </legend>
          <div className="space-y-2">
            {shifts.map((shift) => (
              <label
                key={shift.id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                  shiftId === shift.id
                    ? "border-brand bg-brand-soft"
                    : "border-border-base bg-surface"
                }`}
              >
                <input
                  type="radio"
                  name="shift"
                  value={shift.id}
                  checked={shiftId === shift.id}
                  onChange={() => setShiftId(shift.id)}
                  className="mt-1 h-4 w-4 accent-[var(--brand)]"
                  data-autofocus={shiftId === shift.id ? "" : undefined}
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">
                    {shift.dayLabel} · {shift.serviceName}
                  </span>
                  <span className="block text-sm text-ink-muted">
                    {shift.timeRange}
                    {shift.location ? ` · ${shift.location}` : ""}
                  </span>
                  {shift.approvalRequired ? (
                    <span className="mt-1 block text-sm text-caution">
                      Trading this shift needs chief approval.
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {selected ? (
          <Alert tone="info" className="mb-5">
            <span className="flex items-center gap-1.5">
              <Info className="h-4 w-4" aria-hidden="true" />
              Your schedule only changes once another resident offers a shift and
              you accept it{selected.approvalRequired ? ", and a chief approves" : ""}.
            </span>
          </Alert>
        ) : null}

        <fieldset className="mb-5">
          <legend className="mb-2 block text-sm font-medium text-ink">
            What would you prefer in return? (optional)
          </legend>
          <div className="flex flex-wrap gap-2">
            {["day", "night", "clinic"].map((type) => {
              const active = preferredTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setPreferredTypes((current) =>
                      current.includes(type)
                        ? current.filter((value) => value !== type)
                        : [...current, type],
                    )
                  }
                  className={`min-h-[2.5rem] rounded-full border px-4 text-sm font-medium capitalize ${
                    active
                      ? "border-brand bg-brand-soft text-brand-ink"
                      : "border-border-strong text-ink-muted"
                  }`}
                >
                  {type}
                </button>
              );
            })}
          </div>
        </fieldset>

        <Field
          label="Preferred dates (optional)"
          htmlFor="preferred-dates"
          hint="Comma-separated, e.g. 2026-08-14, 2026-08-15"
        >
          <Input
            id="preferred-dates"
            inputMode="numeric"
            placeholder="2026-08-14, 2026-08-15"
            value={preferredDates}
            onChange={(event) => setPreferredDates(event.target.value)}
          />
        </Field>

        <Field label="Note for your colleagues (optional)" htmlFor="notes">
          <Textarea
            id="notes"
            rows={3}
            maxLength={500}
            placeholder="Family event that weekend — happy to take a night in return."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>

        <div className="sr-only" aria-live="polite">
          {post.pending ? "Posting your shift" : ""}
        </div>
      </Sheet>
    </>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Alert } from "@/components/ui/alert";
import { apiFetch } from "@/lib/api-client";
import { useAction, useOnline } from "@/lib/use-action";
import type { ShiftView } from "@/lib/views";

/**
 * Fixing the hours on a shift you hold.
 *
 * The single most common thing wrong with a schedule that came out of a
 * spreadsheet: the file said 07:00 and the block actually starts at 06:00. The
 * resident is the person who knows, and until they can say so the product is
 * showing everybody a time that is wrong.
 *
 * The sheet opens with the current values already in it — a correction is an
 * edit, not a re-entry, and making somebody retype the hour that was right is
 * how a typo gets introduced fixing a typo.
 */
export function CorrectHoursButton({ shift }: { shift: ShiftView }) {
  const router = useRouter();
  const online = useOnline();
  const [open, setOpen] = React.useState(false);
  const [startTime, setStartTime] = React.useState(shift.startTime);
  const [endTime, setEndTime] = React.useState(shift.endTime);
  const [location, setLocation] = React.useState(shift.location);

  const changed =
    startTime !== shift.startTime ||
    endTime !== shift.endTime ||
    location !== shift.location;

  const save = useAction(
    async () =>
      apiFetch(`/api/shifts/${shift.id}/correct`, {
        method: "POST",
        body: JSON.stringify({
          startTime,
          endTime,
          endsNextDay: endTime <= startTime,
          location,
        }),
      }),
    {
      onSuccess: () => {
        setOpen(false);
        router.refresh();
      },
    },
  );

  return (
    <>
      <Button variant="secondary" block onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
        These hours are wrong
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Correct these hours"
        description="What you put here is what everybody sees, marked as entered by you."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              block
              disabled={!changed || !online}
              loading={save.pending}
              loadingLabel="Saving…"
              onClick={() => save.run()}
            >
              Save
            </Button>
          </div>
        }
      >
        {save.error ? (
          <Alert tone="error" className="mb-4">
            {save.error}
          </Alert>
        ) : null}

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts" htmlFor="correct-start">
              <Input
                id="correct-start"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </Field>
            <Field label="Ends" htmlFor="correct-end">
              <Input
                id="correct-end"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </Field>
          </div>
          {endTime <= startTime ? (
            <p className="text-sm text-ink-muted">
              That runs overnight, so it ends the next morning. It stays one shift.
            </p>
          ) : null}

          <Field label="Where" htmlFor="correct-location">
            <Input
              id="correct-location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="ICU Tower 4"
              maxLength={120}
            />
          </Field>
        </div>
      </Sheet>
    </>
  );
}

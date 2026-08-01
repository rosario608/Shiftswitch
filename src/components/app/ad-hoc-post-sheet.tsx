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

/**
 * "I work this, and I need somebody to take it" — for a resident whose
 * programme has uploaded nothing.
 *
 * ## Why this is not the week-entry form
 *
 * `/schedule/add` asks for a *pattern* — a service, hours, and then the days it
 * applies to — because the thing a resident holds in their head is a block.
 * That is right when they are putting their month in.
 *
 * It is wrong for the moment this sheet covers, which is narrower and more
 * urgent: **one** shift, the one they cannot work, and the only reason they
 * opened the app. Sending them through a six-week grid to tick one square, and
 * then to another screen to post what they just entered, is three screens for
 * one sentence. So this asks for the sentence.
 *
 * ## Everything is already filled in
 *
 * The fields open with a working answer — tomorrow, seven to seven, and the
 * service they are most likely to mean — so the resident who agrees with all of
 * it presses one button. That is what keeps this at the same two taps as
 * posting a shift that already exists; a field they *must* fill before the
 * button does anything would quietly make it three.
 *
 * Nothing defaulted is a guess about *them*: the date and hours are the
 * commonest shape by a distance, they are visible before anything is sent, and
 * every one of them is wrong in a way they can see and correct in place.
 */

function isoDate(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
}

export function AdHocPostButton({
  services,
  label = "Post a shift I'm working",
  variant = "primary",
}: {
  /** Configured services, if the programme has any. Empty is the normal case here. */
  services: string[];
  label?: string;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const online = useOnline();
  const [open, setOpen] = React.useState(false);

  const tomorrow = React.useMemo(() => {
    const at = new Date();
    at.setDate(at.getDate() + 1);
    return isoDate(at);
  }, []);
  const today = React.useMemo(() => isoDate(new Date()), []);

  const [date, setDate] = React.useState(tomorrow);
  const [startTime, setStartTime] = React.useState("07:00");
  const [endTime, setEndTime] = React.useState("19:00");
  const [service, setService] = React.useState(services[0] ?? "");
  const [notes, setNotes] = React.useState("");

  const overnight = endTime <= startTime;

  const post = useAction(
    async () =>
      apiFetch<{ tradeRequest: { id: string } }>("/api/switches/ad-hoc", {
        method: "POST",
        body: JSON.stringify({
          date,
          startTime,
          endTime,
          endsNextDay: overnight,
          service: service.trim(),
          notes: notes.trim() || undefined,
        }),
      }),
    {
      onSuccess: (result) => {
        setOpen(false);
        setNotes("");
        router.push(`/switches/${result.tradeRequest.id}`);
        router.refresh();
      },
    },
  );

  return (
    <>
      <Button variant={variant} block onClick={() => setOpen(true)}>
        <CalendarPlus className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Post a shift"
        description="Tell us the one you need covered. Nobody has to set anything up first."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" onClick={() => setOpen(false)} block>
              Cancel
            </Button>
            <Button
              block
              loading={post.pending}
              loadingLabel="Posting…"
              disabled={!service.trim() || !online}
              onClick={() => post.run()}
            >
              Post it
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
            You&rsquo;re offline. Posting a shift requires an internet connection.
          </Alert>
        ) : null}

        <Field label="Which day?" htmlFor="ad-hoc-date">
          <Input
            id="ad-hoc-date"
            type="date"
            min={today}
            value={date}
            data-autofocus=""
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" htmlFor="ad-hoc-start">
            <Input
              id="ad-hoc-start"
              type="time"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </Field>
          <Field
            label="Ends"
            htmlFor="ad-hoc-end"
            hint={overnight ? "The next morning" : undefined}
          >
            <Input
              id="ad-hoc-end"
              type="time"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="What is it?"
          htmlFor="ad-hoc-service"
          hint="Whatever your program calls it — MICU, Wards, Night float."
        >
          <Input
            id="ad-hoc-service"
            list={services.length > 0 ? "ad-hoc-services" : undefined}
            autoComplete="off"
            placeholder="MICU"
            value={service}
            onChange={(event) => setService(event.target.value)}
          />
          {services.length > 0 ? (
            <datalist id="ad-hoc-services">
              {services.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          ) : null}
        </Field>

        <Alert tone="info" className="mb-5">
          <span className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            This goes on your schedule as entered by you, and says so to whoever
            offers. Your schedule only changes once somebody offers a shift and
            you accept it.
          </span>
        </Alert>

        <Field label="Note for your colleagues (optional)" htmlFor="ad-hoc-notes">
          <Textarea
            id="ad-hoc-notes"
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

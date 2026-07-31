"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export interface ServiceOption {
  id: string;
  name: string;
}

export interface ResidentOption {
  id: string;
  full_name: string;
  pgy_level: number;
  active: boolean;
}

/**
 * Adding one shift by hand.
 *
 * The import is how a program loads a block; this is how somebody fixes the one
 * shift the spreadsheet missed. It writes through the same `createShift` domain
 * function the importer uses, so the timezone handling, the overnight rule and
 * the audit entry are identical — there is no second way to create a shift.
 */
export function ShiftCreateButton({
  services,
  residents,
  timezone,
}: {
  services: ServiceOption[];
  residents: ResidentOption[];
  timezone: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const [serviceId, setServiceId] = React.useState(services[0]?.id ?? "");
  const [date, setDate] = React.useState("");
  const [startTime, setStartTime] = React.useState("07:00");
  const [endTime, setEndTime] = React.useState("19:00");
  const [residentId, setResidentId] = React.useState("");
  const [location, setLocation] = React.useState("");
  const [shiftType, setShiftType] = React.useState("day");

  // An end time at or before the start means the shift runs past midnight.
  // Deriving it removes a checkbox people forget to tick — and getting it wrong
  // silently creates a shift that ends twelve hours before it starts.
  const endsNextDay = endTime <= startTime;

  const create = useAction(
    async () => {
      if (!serviceId) throw new Error("Add a service to your program first.");
      if (!date) throw new Error("Choose a date.");
      return apiFetch("/api/admin/shifts", {
        method: "POST",
        body: JSON.stringify({
          serviceId,
          date,
          startTime,
          endTime,
          endsNextDay,
          location,
          shiftType,
          residentId: residentId || null,
        }),
      });
    },
    {
      onSuccess: () => {
        setOpen(false);
        setDate("");
        setResidentId("");
        router.refresh();
      },
    },
  );

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        New shift
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Add a shift"
        description={`Times are entered and stored in ${timezone}.`}
      >
        <div className="space-y-4">
          <Field label="Service" htmlFor="new-service">
            <Select
              id="new-service"
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
            >
              {services.length === 0 && <option value="">No services yet</option>}
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Date" htmlFor="new-date">
            <Input
              id="new-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" htmlFor="new-start">
              <Input
                id="new-start"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </Field>
            <Field label="End" htmlFor="new-end">
              <Input
                id="new-end"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </Field>
          </div>

          {endsNextDay && (
            <Alert tone="info">
              This shift ends the next morning. It is stored as one overnight
              shift, not two.
            </Alert>
          )}

          <Field label="Assigned resident" htmlFor="new-resident">
            <Select
              id="new-resident"
              value={residentId}
              onChange={(event) => setResidentId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {residents
                .filter((resident) => resident.active)
                .map((resident) => (
                  <option key={resident.id} value={resident.id}>
                    {resident.full_name} · PGY-{resident.pgy_level}
                  </option>
                ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Shift type" htmlFor="new-type">
              <Select
                id="new-type"
                value={shiftType}
                onChange={(event) => setShiftType(event.target.value)}
              >
                <option value="day">Day</option>
                <option value="night">Night</option>
                <option value="call">Call</option>
                <option value="swing">Swing</option>
              </Select>
            </Field>
            <Field label="Location" htmlFor="new-location">
              <Input
                id="new-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="e.g. ICU Tower 4"
              />
            </Field>
          </div>

          {create.error && <Alert tone="error">{create.error}</Alert>}

          <Button block loading={create.pending} onClick={create.run}>
            Add shift
          </Button>
        </div>
      </Sheet>
    </>
  );
}

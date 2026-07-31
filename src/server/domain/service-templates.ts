import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { recordAudit } from "./audit";
import {
  EVERY_DAY_PRESET,
  WEEKDAY_PRESET,
  WEEKEND_PRESET,
  type PgyMixEntry,
} from "./coverage";

/**
 * Starting templates for a programme's service list.
 *
 * ## What a template is, and what it is not
 *
 * It is **a starting point somebody typed once**, not a description of how a
 * programme should work. The Duke Internal Medicine template below is one
 * programme's service list as a plausible starting shape: the names, the
 * staffing numbers and the PGY mixes are all editable, all removable, and all
 * very likely wrong for any other programme and somewhat wrong for Duke.
 *
 * The interface says so in those terms. A template presented as authoritative
 * is worse than no template, because a coordinator setting up a programme at 11
 * o'clock at night will accept whatever it says and discover in October that
 * the MICU has been asking for the wrong number of people since July.
 *
 * ## Why a new service needs no code change
 *
 * Applying a template is `createService` plus `createCoverage` in a loop —
 * exactly the calls the Services screen makes. A programme that wants a service
 * nobody has heard of adds it in the interface, and it is indistinguishable
 * from a templated one afterwards. Nothing downstream reads `source_template`
 * except the screen that shows where a row came from, and nothing branches on
 * its value.
 *
 * Adding a *template* is a new entry in `SERVICE_TEMPLATES`. Adding a *service*
 * needs nothing at all.
 */

export interface TemplateCoverage {
  scope: "weekday";
  label: string;
  days: number[];
  startTime?: string;
  endTime?: string;
  minStaff: number;
  maxStaff?: number | null;
  pgyMix?: PgyMixEntry[];
}

export interface TemplateService {
  name: string;
  abbreviation: string;
  /** Matched by name against the sites the template creates. */
  site: string;
  pgyMin: number;
  pgyMax: number;
  typicalShiftHours: number | null;
  tradeable: boolean;
  coverageMandatory: boolean;
  notes: string;
  coverage: TemplateCoverage[];
}

export interface ServiceTemplate {
  id: string;
  label: string;
  institution: string;
  description: string;
  sites: Array<{ name: string; abbreviation: string; notes?: string }>;
  services: TemplateService[];
}

const everyDay = (
  label: string,
  minStaff: number,
  extras: Partial<TemplateCoverage> = {},
): TemplateCoverage => ({
  scope: "weekday",
  label,
  days: EVERY_DAY_PRESET,
  minStaff,
  ...extras,
});

const weekdays = (
  label: string,
  minStaff: number,
  extras: Partial<TemplateCoverage> = {},
): TemplateCoverage => ({
  scope: "weekday",
  label,
  days: WEEKDAY_PRESET,
  minStaff,
  ...extras,
});

const weekends = (
  label: string,
  minStaff: number,
  extras: Partial<TemplateCoverage> = {},
): TemplateCoverage => ({
  scope: "weekday",
  label,
  days: WEEKEND_PRESET,
  minStaff,
  ...extras,
});

/**
 * Duke Internal Medicine, as a starting point.
 *
 * The service list an internal medicine residency recognises: general medicine
 * wards, the two intensive care units, the subspecialty services, a night
 * float, a day float to absorb sick calls, ambulatory clinic, consults and
 * electives, and the VA as a separate site because it genuinely is one.
 *
 * Every number here is a guess that a programme should replace.
 */
const DUKE_INTERNAL_MEDICINE: ServiceTemplate = {
  id: "duke-internal-medicine",
  label: "Duke Internal Medicine",
  institution: "Duke University Hospital",
  description:
    "A general internal medicine service list: wards, critical care, subspecialties, " +
    "floats, ambulatory and electives, across the university hospital and the VA. " +
    "Every service, staffing number and PGY mix is a starting point to edit, not a recommendation.",
  sites: [
    { name: "Duke University Hospital", abbreviation: "DUH", notes: "Main teaching hospital" },
    {
      name: "Durham VA Medical Center",
      abbreviation: "VA",
      notes: "Separate credentialing — check site eligibility before scheduling",
    },
    { name: "Duke Regional Hospital", abbreviation: "DRH", notes: "Community site" },
  ],
  services: [
    {
      name: "General Medicine Wards",
      abbreviation: "GM Wards",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 12,
      tradeable: true,
      coverageMandatory: true,
      notes: "Teaching teams. A senior supervises the interns on each team.",
      coverage: [
        everyDay("Daily team", 3, {
          minStaff: 3,
          maxStaff: 4,
          // "At least one senior with the interns" — the constraint a ward
          // service most often actually has.
          pgyMix: [
            { pgy: 1, min: 2, max: 3 },
            { pgy: 2, min: 1, max: 2 },
          ],
        }),
      ],
    },
    {
      name: "Medical Intensive Care Unit",
      abbreviation: "MICU",
      site: "Duke University Hospital",
      pgyMin: 2,
      pgyMax: 3,
      typicalShiftHours: 12,
      tradeable: true,
      coverageMandatory: true,
      notes: "Seniors only. Critical care credential required.",
      coverage: [
        everyDay("Day", 2, {
          startTime: "07:00",
          endTime: "19:00",
          minStaff: 2,
          maxStaff: 3,
          pgyMix: [{ pgy: 2, min: 1, max: null }],
        }),
        everyDay("Night", 1, { startTime: "19:00", endTime: "07:00", minStaff: 1, maxStaff: 2 }),
      ],
    },
    {
      name: "Cardiac Intensive Care Unit",
      abbreviation: "CICU",
      site: "Duke University Hospital",
      pgyMin: 2,
      pgyMax: 3,
      typicalShiftHours: 12,
      tradeable: true,
      coverageMandatory: true,
      notes: "Seniors only.",
      coverage: [
        everyDay("Day", 2, { startTime: "07:00", endTime: "19:00", minStaff: 2, maxStaff: 2 }),
        everyDay("Night", 1, { startTime: "19:00", endTime: "07:00", minStaff: 1, maxStaff: 1 }),
      ],
    },
    {
      name: "Cardiology",
      abbreviation: "Cards",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 10,
      tradeable: true,
      coverageMandatory: true,
      notes: "Inpatient cardiology service.",
      coverage: [everyDay("Daily", 2, { minStaff: 2, maxStaff: 3 })],
    },
    {
      name: "Malignant Hematology",
      abbreviation: "Mal Heme",
      site: "Duke University Hospital",
      pgyMin: 2,
      pgyMax: 3,
      typicalShiftHours: 10,
      tradeable: true,
      coverageMandatory: true,
      notes: "Transplant and leukaemia service.",
      coverage: [everyDay("Daily", 1, { minStaff: 1, maxStaff: 2 })],
    },
    {
      name: "Neurology",
      abbreviation: "Neuro",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 10,
      tradeable: true,
      coverageMandatory: true,
      notes: "",
      coverage: [everyDay("Daily", 1, { minStaff: 1, maxStaff: 2 })],
    },
    {
      name: "Emergency Department",
      abbreviation: "ED",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 2,
      typicalShiftHours: 9,
      tradeable: true,
      coverageMandatory: true,
      notes: "Shift-based; no continuity requirement.",
      coverage: [everyDay("Daily", 1, { minStaff: 1, maxStaff: 3 })],
    },
    {
      name: "Night Medicine",
      abbreviation: "Nights",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 12,
      tradeable: true,
      coverageMandatory: true,
      notes: "Overnight cross-cover and admissions.",
      coverage: [
        everyDay("Overnight", 2, {
          startTime: "19:00",
          endTime: "07:00",
          minStaff: 2,
          maxStaff: 3,
          // The constraint that matters overnight: never an intern alone.
          pgyMix: [
            { pgy: 1, min: 1, max: 2 },
            { pgy: 2, min: 1, max: null },
          ],
        }),
      ],
    },
    {
      name: "Day Float",
      abbreviation: "Day Float",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 10,
      tradeable: true,
      coverageMandatory: false,
      notes: "Absorbs sick calls and admission surges. Not mandatory every day.",
      coverage: [weekdays("Weekdays", 1, { minStaff: 1, maxStaff: 2 })],
    },
    {
      name: "Ambulatory Clinic",
      abbreviation: "Clinic",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 8,
      // Continuity clinic is the classic non-tradeable: the point is that the
      // same resident sees the same patients.
      tradeable: false,
      coverageMandatory: true,
      notes: "Continuity clinic. Not tradeable — continuity is the point.",
      coverage: [
        weekdays("Clinic sessions", 4, {
          startTime: "08:00",
          endTime: "17:00",
          minStaff: 4,
          maxStaff: 8,
        }),
      ],
    },
    {
      name: "Consults",
      abbreviation: "Consults",
      site: "Duke University Hospital",
      pgyMin: 2,
      pgyMax: 3,
      typicalShiftHours: 9,
      tradeable: true,
      coverageMandatory: true,
      notes: "General medicine consult service.",
      coverage: [
        weekdays("Weekdays", 1, { minStaff: 1, maxStaff: 2 }),
        weekends("Weekend cover", 1, { minStaff: 1, maxStaff: 1 }),
      ],
    },
    {
      name: "Elective",
      abbreviation: "Elective",
      site: "Duke University Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: null,
      tradeable: false,
      coverageMandatory: false,
      notes: "Resident-chosen. No coverage requirement by design.",
      coverage: [],
    },
    {
      name: "VA Wards",
      abbreviation: "VA Wards",
      site: "Durham VA Medical Center",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 10,
      tradeable: true,
      coverageMandatory: true,
      notes: "Requires VA credentialing — check site eligibility.",
      coverage: [
        everyDay("Daily team", 2, {
          minStaff: 2,
          maxStaff: 3,
          pgyMix: [{ pgy: 2, min: 1, max: null }],
        }),
      ],
    },
    {
      name: "VA Ambulatory",
      abbreviation: "VA Clinic",
      site: "Durham VA Medical Center",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 8,
      tradeable: false,
      coverageMandatory: false,
      notes: "Requires VA credentialing.",
      coverage: [weekdays("Weekdays", 2, { minStaff: 2, maxStaff: 4 })],
    },
    {
      name: "Community Wards",
      abbreviation: "DRH Wards",
      site: "Duke Regional Hospital",
      pgyMin: 1,
      pgyMax: 3,
      typicalShiftHours: 10,
      tradeable: true,
      coverageMandatory: true,
      notes: "Community hospital experience.",
      coverage: [everyDay("Daily team", 2, { minStaff: 2, maxStaff: 3 })],
    },
  ],
};

export const SERVICE_TEMPLATES: ServiceTemplate[] = [DUKE_INTERNAL_MEDICINE];

export function findTemplate(id: string): ServiceTemplate | null {
  return SERVICE_TEMPLATES.find((template) => template.id === id) ?? null;
}

export interface TemplateApplication {
  sitesCreated: number;
  servicesCreated: number;
  servicesSkipped: string[];
  coverageCreated: number;
}

/**
 * Applies a template, skipping anything the programme already has.
 *
 * Skipping rather than overwriting, and reporting what was skipped. A
 * coordinator who applies a template twice, or applies it after adding two
 * services by hand, must not lose the work they did — and the second run
 * telling them "MICU already existed, left alone" is more useful than either
 * silently doing nothing or silently replacing it.
 *
 * The whole thing is one transaction: a template half-applied is a service list
 * that looks complete and is not.
 */
export async function applyServiceTemplate(
  context: AuthedContext,
  templateId: string,
): Promise<TemplateApplication> {
  const template = findTemplate(templateId);
  if (!template) {
    throw new Error(`No service template with id "${templateId}".`);
  }

  return withTransaction(async (client) => {
    const result: TemplateApplication = {
      sitesCreated: 0,
      servicesCreated: 0,
      servicesSkipped: [],
      coverageCreated: 0,
    };

    const siteIds = new Map<string, string>();
    for (const site of template.sites) {
      const existing = await queryOne<{ id: string }>(
        "SELECT id FROM sites WHERE program_id = $1 AND lower(name) = lower($2)",
        [context.program.id, site.name],
        client,
      );
      if (existing) {
        siteIds.set(site.name, existing.id);
        continue;
      }
      const created = (await queryOne<{ id: string }>(
        `INSERT INTO sites (program_id, name, abbreviation, notes)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [context.program.id, site.name, site.abbreviation, site.notes ?? ""],
        client,
      ))!;
      siteIds.set(site.name, created.id);
      result.sitesCreated += 1;
    }

    for (const service of template.services) {
      const existing = await queryOne<{ id: string }>(
        "SELECT id FROM services WHERE program_id = $1 AND lower(name) = lower($2)",
        [context.program.id, service.name],
        client,
      );
      if (existing) {
        result.servicesSkipped.push(service.name);
        continue;
      }

      const created = (await queryOne<{ id: string }>(
        `INSERT INTO services
           (program_id, name, abbreviation, site_id, pgy_min, pgy_max,
            typical_shift_hours, tradeable, coverage_mandatory, notes,
            source_template, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
         RETURNING id`,
        [
          context.program.id,
          service.name,
          service.abbreviation,
          siteIds.get(service.site) ?? null,
          service.pgyMin,
          service.pgyMax,
          service.typicalShiftHours,
          service.tradeable,
          service.coverageMandatory,
          service.notes,
          template.id,
        ],
        client,
      ))!;
      result.servicesCreated += 1;

      for (const coverage of service.coverage) {
        await query(
          `INSERT INTO coverage_requirements
             (program_id, service_id, scope, label, days_of_week, start_time,
              end_time, min_staff, max_staff, pgy_mix)
           VALUES ($1, $2, 'weekday', $3, $4::smallint[], $5, $6, $7, $8, $9::jsonb)`,
          [
            context.program.id,
            created.id,
            coverage.label,
            coverage.days,
            coverage.startTime ?? null,
            coverage.endTime ?? null,
            coverage.minStaff,
            coverage.maxStaff ?? null,
            JSON.stringify(coverage.pgyMix ?? []),
          ],
          client,
        );
        result.coverageCreated += 1;
      }
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "services.template_applied",
        entityType: "program",
        entityId: context.program.id,
        newState: {
          template: template.id,
          sitesCreated: result.sitesCreated,
          servicesCreated: result.servicesCreated,
          skipped: result.servicesSkipped,
        },
      },
      client,
    );

    return result;
  });
}

/**
 * Turning a diary into instants, and back.
 *
 * A provider writes their diary in wall-clock terms: "Tuesdays, 9 to 5", "the
 * 14th is blocked". A consultation is booked at an INSTANT
 * (`consultations.scheduled_start_at` is `timestamptz`). Nothing can move
 * between the two without naming a time zone, so `PLATFORM_TIMEZONE` names one
 * for the whole deployment - see `env.validation.ts` for why it is one setting
 * rather than a column on every provider.
 *
 * Everything here is pure and takes the zone as an argument, so the rules can
 * be tested in a zone that actually has daylight saving even though the launch
 * zone does not.
 */

/** A date on a calendar, with no time and no zone. */
export interface LocalDate {
  year: number;
  /** 1 to 12, as a human writes it - NOT JavaScript's 0-based month. */
  month: number;
  day: number;
}

/** Minutes since local midnight. 9:30am is 570. */
export type MinutesOfDay = number;

export const MINUTES_PER_DAY = 24 * 60;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timeZone);
  if (!existing) {
    existing = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // `h23` and not `hour12: false`: some ICU versions render midnight as 24
      // under the latter, which would push every early-morning slot a day out.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, existing);
  }
  return existing;
}

function fields(instant: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const f = fields(instant, timeZone);
  const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  // The formatted parts stop at seconds, so compare against a truncated instant
  // rather than letting stray milliseconds show up as a fractional offset.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The calendar date an instant falls on, locally. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const f = fields(instant, timeZone);
  return { year: f.year, month: f.month, day: f.day };
}

/** Where an instant sits in its local day. */
export function minutesOfDayOf(instant: Date, timeZone: string): MinutesOfDay {
  const f = fields(instant, timeZone);
  return f.hour * 60 + f.minute;
}

/**
 * 0 Sunday through 6 Saturday, matching `doctor_availability.day_of_week`.
 * Pure calendar arithmetic - a date's weekday does not depend on a zone.
 */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * The instant at which a local date and time occurs.
 *
 * The offset is applied twice on purpose. The first pass uses the offset in
 * force at roughly the right moment; the second re-reads it having landed
 * there, which is what makes the answer correct on the two days a year a zone
 * with daylight saving shifts. India does not shift, but a deployment in a zone
 * that does must not be an hour out.
 */
export function instantOf(date: LocalDate, minutes: MinutesOfDay, timeZone: string): Date {
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  const firstPass = asIfUtc - offsetMs(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - offsetMs(new Date(firstPass), timeZone));
}

/** `2026-09-14`. The stable key a day's rules are grouped under. */
export function dateKey(date: LocalDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Every local date touched by the window, both ends included. */
export function localDatesBetween(from: Date, to: Date, timeZone: string): LocalDate[] {
  const last = dateKey(localDateOf(to, timeZone));
  const dates: LocalDate[] = [];
  let cursor = localDateOf(from, timeZone);
  // A guard rather than a `while (true)`: a caller that asks for a decade of
  // slots should get a bounded answer, not a loop that never comes back.
  for (let guard = 0; guard < 400; guard += 1) {
    dates.push(cursor);
    if (dateKey(cursor) >= last) break;
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/**
 * Reads a `time` column as minutes since midnight.
 *
 * Postgres `time` has no date and no zone. Prisma hands it back as a `Date`
 * pinned to 1970-01-01 UTC, but a driver that returns the raw `09:00:00` string
 * is a configuration change away, and the difference between the two would be a
 * whole working day appearing in the wrong place. Both are read here.
 */
export function minutesFromTimeColumn(value: Date | string | null): MinutesOfDay | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    const [hours, minutes] = value.split(':');
    return Number(hours) * 60 + Number(minutes);
  }
  // Postgres accepts `24:00:00` for a window that runs to midnight, and Prisma
  // renders that as the following day. The day carries a whole 1440 minutes.
  const rolled = Math.round(
    (Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) -
      Date.UTC(1970, 0, 1)) /
      86_400_000,
  );
  return rolled * MINUTES_PER_DAY + value.getUTCHours() * 60 + value.getUTCMinutes();
}

/**
 * Minutes since midnight as a `time` column value.
 *
 * *** NOT USED FOR WRITES. *** Prisma keeps only a Date's time of day, so 1440
 * minutes - midnight at the END of a day - would serialise to `00:00:00` and
 * lose the very distinction the diary needs. `AvailabilityService` writes the
 * times as SQL literals for that reason; this stays as the inverse of
 * `minutesFromTimeColumn`, which is what the round-trip tests exercise.
 */
export function timeColumnFromMinutes(minutes: MinutesOfDay): Date {
  return new Date(Date.UTC(1970, 0, 1, 0, minutes));
}

/** `09:30`. What the API speaks, in and out. */
export function formatMinutes(minutes: MinutesOfDay): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `09:30` to 570. Validation of the shape is the DTO's job. */
export function parseMinutes(value: string): MinutesOfDay {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Reads a `date` column, which Prisma pins to UTC midnight. */
export function localDateFromColumn(value: Date): LocalDate {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

/** Writes a `LocalDate` back into a `date` column. */
export function dateColumnFrom(date: LocalDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/** `2026-09-14` from the API into a `LocalDate`. Shape is the DTO's job. */
export function parseLocalDate(value: string): LocalDate {
  const [year, month, day] = value.split('-');
  return { year: Number(year), month: Number(month), day: Number(day) };
}

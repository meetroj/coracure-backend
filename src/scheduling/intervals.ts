/**
 * Interval algebra, and nothing else.
 *
 * Every question M-07 answers is the same shape underneath: take the windows a
 * provider offers, take away the windows something else already occupies, and
 * look at what is left. Blocked dates, leave, a gap in the middle of a day and
 * a booked consultation are all the same operation - which is why they are one
 * function here rather than four branches in the service.
 *
 * Pure, synchronous, and no clock of its own, so the edges can be tested
 * exhaustively without a database or a fixed "now".
 */

/** Half-open: `[startsAt, endsAt)`. A consultation ending at 10:00 and one starting at 10:00 do not overlap. */
export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

const MINUTE_MS = 60_000;

export function minutesLong(interval: Interval): number {
  return (interval.endsAt.getTime() - interval.startsAt.getTime()) / MINUTE_MS;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

/**
 * Sorted, with zero-length intervals dropped and overlapping or touching ones
 * merged. Two windows that meet at 13:00 become one: a provider free 9-13 and
 * 13-17 has an unbroken afternoon, and FR-10.7 asks about unbroken time.
 */
export function normalise(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.endsAt.getTime() > interval.startsAt.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startsAt.getTime() <= last.endsAt.getTime()) {
      if (interval.endsAt.getTime() > last.endsAt.getTime()) last.endsAt = interval.endsAt;
      continue;
    }
    merged.push({ startsAt: interval.startsAt, endsAt: interval.endsAt });
  }
  return merged;
}

/**
 * What is left of `from` once every interval in `holes` is taken out. This is
 * blocked hours, leave and existing bookings all at once.
 */
export function subtract(from: Interval[], holes: Interval[]): Interval[] {
  const gaps = normalise(holes);
  let remaining = normalise(from);

  for (const gap of gaps) {
    const next: Interval[] = [];
    for (const interval of remaining) {
      const overlaps =
        gap.startsAt.getTime() < interval.endsAt.getTime() &&
        gap.endsAt.getTime() > interval.startsAt.getTime();
      if (!overlaps) {
        next.push(interval);
        continue;
      }
      if (gap.startsAt.getTime() > interval.startsAt.getTime()) {
        next.push({ startsAt: interval.startsAt, endsAt: gap.startsAt });
      }
      if (gap.endsAt.getTime() < interval.endsAt.getTime()) {
        next.push({ startsAt: gap.endsAt, endsAt: interval.endsAt });
      }
    }
    remaining = next;
  }
  return remaining;
}

/** The part of each interval that falls inside `window`. */
export function clip(intervals: Interval[], window: Interval): Interval[] {
  const clipped: Interval[] = [];
  for (const interval of intervals) {
    const startsAt = new Date(Math.max(interval.startsAt.getTime(), window.startsAt.getTime()));
    const endsAt = new Date(Math.min(interval.endsAt.getTime(), window.endsAt.getTime()));
    if (endsAt.getTime() > startsAt.getTime()) clipped.push({ startsAt, endsAt });
  }
  return clipped;
}

/** The interval `at` falls inside, if any. `intervals` must be normalised. */
export function surrounding(intervals: Interval[], at: Date): Interval | undefined {
  return intervals.find(
    (interval) =>
      interval.startsAt.getTime() <= at.getTime() && interval.endsAt.getTime() > at.getTime(),
  );
}

/** True when one single interval holds the whole of `range`. Never two abutting ones - `normalise` has already merged those. */
export function holds(intervals: Interval[], range: Interval): boolean {
  return intervals.some(
    (interval) =>
      interval.startsAt.getTime() <= range.startsAt.getTime() &&
      interval.endsAt.getTime() >= range.endsAt.getTime(),
  );
}

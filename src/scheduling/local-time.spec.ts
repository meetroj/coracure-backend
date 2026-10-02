import { describe, expect, it } from 'vitest';

import {
  addDays,
  dateKey,
  instantOf,
  localDateOf,
  localDatesBetween,
  minutesFromTimeColumn,
  minutesOfDayOf,
  parseMinutes,
  timeColumnFromMinutes,
  weekdayOf,
} from './local-time';

const IST = 'Asia/Kolkata';
/** A zone that actually shifts, so the DST arithmetic is exercised rather than assumed. */
const NEW_YORK = 'America/New_York';

describe('local-time', () => {
  it('turns a local wall clock into the instant it happens', () => {
    // 09:00 in a zone 5h30 ahead of UTC is 03:30Z the same morning.
    const at = instantOf({ year: 2026, month: 9, day: 14 }, parseMinutes('09:00'), IST);
    expect(at.toISOString()).toBe('2026-09-14T03:30:00.000Z');
  });

  it('reads an instant back as the local date and time it falls on', () => {
    const at = new Date('2026-09-13T20:00:00.000Z');
    // Late evening UTC is already the next morning in IST, which is exactly the
    // mistake a diary computed in UTC would make.
    expect(localDateOf(at, IST)).toEqual({ year: 2026, month: 9, day: 14 });
    expect(minutesOfDayOf(at, IST)).toBe(90);
  });

  it('applies the offset in force on the day, not the offset today', () => {
    // 12:00 in New York is 16:00Z in July and 17:00Z in January. A single-pass
    // conversion anchored on one of them is an hour out for half the year.
    const summer = instantOf({ year: 2026, month: 7, day: 1 }, 12 * 60, NEW_YORK);
    const winter = instantOf({ year: 2026, month: 1, day: 1 }, 12 * 60, NEW_YORK);
    expect(summer.toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(winter.toISOString()).toBe('2026-01-01T17:00:00.000Z');
  });

  it('lands on the right instant on the morning a zone springs forward', () => {
    // 08 March 2026, 02:00 does not exist in New York. 09:00 that day still does.
    const at = instantOf({ year: 2026, month: 3, day: 8 }, 9 * 60, NEW_YORK);
    expect(minutesOfDayOf(at, NEW_YORK)).toBe(9 * 60);
  });

  it('numbers weekdays as the column does, 0 Sunday to 6 Saturday', () => {
    expect(weekdayOf({ year: 2026, month: 9, day: 13 })).toBe(0);
    expect(weekdayOf({ year: 2026, month: 9, day: 14 })).toBe(1);
    expect(weekdayOf({ year: 2026, month: 9, day: 19 })).toBe(6);
  });

  it('rolls a date over a month end', () => {
    expect(addDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 1 });
    expect(dateKey(addDays({ year: 2026, month: 3, day: 1 }, -1))).toBe('2026-02-28');
  });

  it('enumerates every local date a window touches, both ends included', () => {
    const dates = localDatesBetween(
      new Date('2026-09-13T20:00:00.000Z'),
      new Date('2026-09-15T02:00:00.000Z'),
      IST,
    );
    expect(dates.map(dateKey)).toEqual(['2026-09-14', '2026-09-15']);
  });

  it('round-trips a time column', () => {
    expect(minutesFromTimeColumn(timeColumnFromMinutes(9 * 60 + 30))).toBe(570);
  });

  it('reads a time column whether the driver hands back a Date or a string', () => {
    // Both shapes are a driver setting apart, and confusing them would move a
    // whole working day rather than fail.
    expect(minutesFromTimeColumn(new Date('1970-01-01T17:00:00.000Z'))).toBe(1020);
    expect(minutesFromTimeColumn('17:00:00')).toBe(1020);
  });

  it('reads a window that ends at midnight as a full day, not as zero', () => {
    // Postgres accepts 24:00:00 and renders it on the following day. Read
    // naively it would come back as 00:00 and erase the provider's evening.
    expect(minutesFromTimeColumn(timeColumnFromMinutes(24 * 60))).toBe(1440);
    expect(minutesFromTimeColumn('24:00:00')).toBe(1440);
  });
});

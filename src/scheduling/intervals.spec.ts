import { describe, expect, it } from 'vitest';

import { Interval, clip, holds, minutesLong, normalise, subtract, surrounding } from './intervals';

/** `at('09:00')` on one fixed morning. Keeps the cases readable. */
const at = (time: string) => new Date(`2026-09-14T${time}:00.000Z`);
const span = (start: string, end: string): Interval => ({ startsAt: at(start), endsAt: at(end) });
const show = (intervals: Interval[]) =>
  intervals.map((interval) => [
    interval.startsAt.toISOString().slice(11, 16),
    interval.endsAt.toISOString().slice(11, 16),
  ]);

describe('intervals', () => {
  it('merges windows that touch into one unbroken run', () => {
    // FR-10.7 asks about UNBROKEN time. A provider free 09:00-13:00 and
    // 13:00-17:00 has an eight-hour run, not two four-hour ones, and reporting
    // the shorter figure would refuse them a long consultation they can take.
    expect(show(normalise([span('13:00', '17:00'), span('09:00', '13:00')]))).toEqual([
      ['09:00', '17:00'],
    ]);
  });

  it('drops a window of no length', () => {
    expect(normalise([span('09:00', '09:00')])).toEqual([]);
  });

  it('splits a window around something booked in the middle of it', () => {
    expect(show(subtract([span('09:00', '17:00')], [span('12:00', '13:00')]))).toEqual([
      ['09:00', '12:00'],
      ['13:00', '17:00'],
    ]);
  });

  it('trims a window a booking overlaps at one end', () => {
    expect(show(subtract([span('09:00', '17:00')], [span('08:00', '10:00')]))).toEqual([
      ['10:00', '17:00'],
    ]);
  });

  it('removes a window a whole day of leave covers', () => {
    expect(subtract([span('09:00', '17:00')], [span('00:00', '23:59')])).toEqual([]);
  });

  it('leaves a window alone when the hole only abuts it', () => {
    // Half-open intervals: a consultation ending at 10:00 and a window starting
    // at 10:00 do not overlap, so the window keeps its first minute.
    expect(show(subtract([span('10:00', '12:00')], [span('09:00', '10:00')]))).toEqual([
      ['10:00', '12:00'],
    ]);
  });

  it('subtracts several holes at once', () => {
    expect(
      show(subtract([span('09:00', '17:00')], [span('10:00', '10:30'), span('14:00', '15:00')])),
    ).toEqual([
      ['09:00', '10:00'],
      ['10:30', '14:00'],
      ['15:00', '17:00'],
    ]);
  });

  it('clips to the window asked for', () => {
    expect(show(clip([span('06:00', '22:00')], span('09:00', '17:00')))).toEqual([
      ['09:00', '17:00'],
    ]);
  });

  it('finds the run a moment falls inside, and none at its end', () => {
    const runs = [span('09:00', '12:00')];
    expect(minutesLong(surrounding(runs, at('11:00'))!)).toBe(180);
    expect(surrounding(runs, at('12:00'))).toBeUndefined();
  });

  it('holds a range only when ONE run covers all of it', () => {
    const split = [span('09:00', '10:00'), span('10:30', '12:00')];
    expect(holds(split, span('09:00', '09:30'))).toBe(true);
    // 09:45 to 10:45 spans the gap. Two runs either side is not availability.
    expect(holds(split, span('09:45', '10:45'))).toBe(false);
  });
});

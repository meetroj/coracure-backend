import { Party } from '@prisma/client';

/** The two parties that can ever appear on a connection row. */
export type CallParty = Extract<Party, 'patient' | 'doctor'>;

/** One `consultation_participants` row, reduced to what the arithmetic needs. */
export interface Connection {
  party: CallParty;
  joinedAt: Date;
  /** Null while still connected - or if the leave webhook never arrived. */
  leftAt: Date | null;
  disconnectReason?: string | null;
}

/** How one party's connections went. A reconnect is visible, not smoothed away. */
export interface PartyAttendance {
  attended: boolean;
  /** More than one means they dropped and came back. */
  connections: number;
  firstJoinedAt: Date | null;
  lastLeftAt: Date | null;
  /** Their own connected time, with overlapping connections counted once. */
  connectedSeconds: number;
  stillConnected: boolean;
}

export interface SessionSummary {
  /** min(joined_at) across both parties. Null before anybody joins. */
  startedAt: Date | null;
  /** max(left_at). Null while anybody is still connected. */
  endedAt: Date | null;
  /**
   * *** THE CALL DURATION. *** The time BOTH parties were connected at once -
   * which is the only span during which a consultation was actually happening.
   *
   * Not the sum of the two parties' connected time, which would count a
   * two-way call twice, and not `endedAt - startedAt`, which would count a
   * doctor's ten minutes alone in the room waiting for a patient who never
   * arrived. Those two figures are here as well, separately, because a
   * technical-issue complaint needs to tell those cases apart.
   */
  durationSeconds: number;
  patient: PartyAttendance;
  doctor: PartyAttendance;
  /**
   * The party with NO connection row (SRS schema note, MODULES M-14). Null when
   * both showed up, and null when NEITHER did - "which one failed to show" has
   * no answer in that case, and `patient.attended` says so plainly.
   */
  noShowParty: CallParty | null;
}

interface Interval {
  from: number;
  to: number;
}

/**
 * *** EVERY FIGURE ABOUT A CALL IS COMPUTED HERE, AND NONE OF THEM IS STORED. ***
 *
 * `consultations` deliberately carries no `video_duration`, no `started_at` and
 * no `ended_at`, and `consultation_participants` carries no `no_show_party`.
 * All four are functions of the connection rows, and a stored copy of a
 * function is a second source of truth that drifts from the first.
 *
 * The rows are per CONNECTION rather than per person, which is what makes this
 * arithmetic necessary in the first place: a patient whose phone loses signal
 * and reconnects has three rows and two gaps, and every one of these figures
 * has to survive that.
 *
 * @param now bounds a connection that has not closed yet. A row stays open
 *   while the participant is genuinely still in the call - and also if the
 *   leave webhook was lost, which is why `stillConnected` is reported rather
 *   than quietly folded into a duration a reader would take as final.
 */
export function summariseSession(connections: Connection[], now: Date): SessionSummary {
  const patient = attendanceOf(connections, 'patient', now);
  const doctor = attendanceOf(connections, 'doctor', now);

  const starts = [patient.firstJoinedAt, doctor.firstJoinedAt].filter(isDate);
  const ends = [patient.lastLeftAt, doctor.lastLeftAt].filter(isDate);
  const anyoneStillConnected = patient.stillConnected || doctor.stillConnected;

  return {
    startedAt: starts.length > 0 ? new Date(Math.min(...starts.map(toMillis))) : null,
    // Null while anybody is still in the room: a call with one party connected
    // has not ended, whatever the other party's last leave time says.
    endedAt:
      !anyoneStillConnected && ends.length > 0 ? new Date(Math.max(...ends.map(toMillis))) : null,
    durationSeconds: overlapSeconds(
      intervalsOf(connections, 'patient', now),
      intervalsOf(connections, 'doctor', now),
    ),
    patient,
    doctor,
    noShowParty: absentee(patient, doctor),
  };
}

/** Exactly one party missing. Both missing has no single answer, so it is null. */
function absentee(patient: PartyAttendance, doctor: PartyAttendance): CallParty | null {
  if (patient.attended === doctor.attended) return null;
  return patient.attended ? 'doctor' : 'patient';
}

function attendanceOf(connections: Connection[], party: CallParty, now: Date): PartyAttendance {
  const mine = connections.filter((row) => row.party === party);
  if (mine.length === 0) {
    return {
      attended: false,
      connections: 0,
      firstJoinedAt: null,
      lastLeftAt: null,
      connectedSeconds: 0,
      stillConnected: false,
    };
  }

  const joins = mine.map((row) => row.joinedAt.getTime());
  const leaves = mine.map((row) => row.leftAt).filter(isDate);
  const stillConnected = mine.some((row) => row.leftAt === null);

  return {
    attended: true,
    connections: mine.length,
    firstJoinedAt: new Date(Math.min(...joins)),
    lastLeftAt:
      stillConnected || leaves.length === 0 ? null : new Date(Math.max(...leaves.map(toMillis))),
    // Merged, not summed: LiveKit hands a reconnecting participant a new SID
    // before tearing the stale connection down, so two rows can genuinely
    // overlap for a second or two and that second was not lived twice.
    connectedSeconds: totalSeconds(merge(intervalsOf(connections, party, now))),
    stillConnected,
  };
}

function intervalsOf(connections: Connection[], party: CallParty, now: Date): Interval[] {
  return (
    connections
      .filter((row) => row.party === party)
      .map((row) => ({ from: row.joinedAt.getTime(), to: (row.leftAt ?? now).getTime() }))
      // A connection that closed before it opened is refused by a CHECK, so this
      // only drops the zero-length ones - a join and a leave in the same instant.
      .filter((interval) => interval.to > interval.from)
  );
}

/** Overlapping or touching intervals become one. Input order is not assumed. */
function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
    else merged.push({ ...interval });
  }
  return merged;
}

/** The time covered by BOTH sets. Two merged, sorted lists walked in step. */
function overlapSeconds(left: Interval[], right: Interval[]): number {
  const a = merge(left);
  const b = merge(right);
  let i = 0;
  let j = 0;
  let milliseconds = 0;
  while (i < a.length && j < b.length) {
    const from = Math.max(a[i].from, b[j].from);
    const to = Math.min(a[i].to, b[j].to);
    if (to > from) milliseconds += to - from;
    // Advance whichever ends first; the other may still overlap what comes next.
    if (a[i].to < b[j].to) i += 1;
    else j += 1;
  }
  return Math.round(milliseconds / 1000);
}

function totalSeconds(intervals: Interval[]): number {
  return Math.round(intervals.reduce((sum, i) => sum + (i.to - i.from), 0) / 1000);
}

function isDate(value: Date | null | undefined): value is Date {
  return value instanceof Date;
}

function toMillis(value: Date): number {
  return value.getTime();
}

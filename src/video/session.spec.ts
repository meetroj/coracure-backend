import { describe, expect, it } from 'vitest';

import { CallParty, Connection, summariseSession } from './session';

const at = (minute: number) => new Date(`2026-09-14T10:${String(minute).padStart(2, '0')}:00.000Z`);
const NOW = at(59);

const connection = (party: CallParty, from: number, to: number | null): Connection => ({
  party,
  joinedAt: at(from),
  leftAt: to === null ? null : at(to),
});

describe('the session record (every figure computed, none stored)', () => {
  it('has nothing to say about a call that never happened', () => {
    const session = summariseSession([], NOW);
    expect(session.startedAt).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(session.durationSeconds).toBe(0);
    // Nobody came. "Which one failed to show" has no answer, and saying
    // `patient` would be half a truth.
    expect(session.noShowParty).toBeNull();
    expect(session.patient.attended).toBe(false);
    expect(session.doctor.attended).toBe(false);
  });

  it('reads a clean consultation off the two connections', () => {
    const session = summariseSession(
      [connection('patient', 0, 30), connection('doctor', 2, 31)],
      NOW,
    );
    // min(joined_at) and max(left_at). Neither is a column.
    expect(session.startedAt).toEqual(at(0));
    expect(session.endedAt).toEqual(at(31));
    // 10:02 to 10:30 - the time both were actually in the room.
    expect(session.durationSeconds).toBe(28 * 60);
    expect(session.noShowParty).toBeNull();
  });

  /**
   * *** THE REASON THIS TABLE IS ONE ROW PER CONNECTION. ***
   *
   * A patient whose phone drops signal and comes back has three rows and a gap.
   * The four timestamps this replaced could hold the first join and the last
   * leave and nothing in between, so the gap was invisible and the reconnect
   * overwrote the session it was resuming.
   */
  it('counts a reconnect as one call with a gap in it, not as two calls', () => {
    const session = summariseSession(
      [
        connection('patient', 0, 10),
        // Five minutes on a train.
        connection('patient', 15, 30),
        connection('doctor', 0, 30),
      ],
      NOW,
    );
    expect(session.patient.connections).toBe(2);
    expect(session.patient.connectedSeconds).toBe(25 * 60);
    // The doctor was there throughout; the call is what they SHARED, so the
    // five minutes the patient was reconnecting are not consultation time.
    expect(session.doctor.connectedSeconds).toBe(30 * 60);
    expect(session.durationSeconds).toBe(25 * 60);
    expect(session.startedAt).toEqual(at(0));
    expect(session.endedAt).toEqual(at(30));
  });

  /**
   * The duration is the OVERLAP, not the sum and not the span. A doctor sitting
   * alone in a room for twenty minutes had a consultation of zero, whatever the
   * clock between their join and their leave says.
   */
  it('gives a doctor who waited alone a duration of zero', () => {
    const session = summariseSession([connection('doctor', 0, 20)], NOW);
    expect(session.doctor.connectedSeconds).toBe(20 * 60);
    expect(session.durationSeconds).toBe(0);
    // The party with NO row is the one who did not show. Not a stored column.
    expect(session.noShowParty).toBe('patient');
  });

  it('names the doctor when it was the doctor who never arrived', () => {
    expect(summariseSession([connection('patient', 0, 20)], NOW).noShowParty).toBe('doctor');
  });

  /**
   * LiveKit hands a reconnecting participant a new SID before tearing the stale
   * connection down, so two rows for one party genuinely overlap for a moment.
   * That moment was not lived twice.
   */
  it('does not count overlapping connections of one party twice', () => {
    const session = summariseSession(
      [connection('patient', 0, 12), connection('patient', 10, 20)],
      NOW,
    );
    expect(session.patient.connectedSeconds).toBe(20 * 60);
  });

  it('leaves a call that is still running open-ended', () => {
    const session = summariseSession(
      [connection('patient', 50, null), connection('doctor', 52, null)],
      NOW,
    );
    expect(session.startedAt).toEqual(at(50));
    // Nobody has left, so the call has not ended - whatever any leave time says.
    expect(session.endedAt).toBeNull();
    expect(session.patient.stillConnected).toBe(true);
    // Seven minutes so far: 10:52 to 10:59.
    expect(session.durationSeconds).toBe(7 * 60);
  });

  /**
   * One party still connected and the other gone is not an ended call: the
   * doctor writing up while the patient's connection lingers has not finished.
   */
  it('does not end a call while one party is still in the room', () => {
    const session = summariseSession(
      [connection('patient', 0, null), connection('doctor', 0, 30)],
      NOW,
    );
    expect(session.endedAt).toBeNull();
    expect(session.doctor.lastLeftAt).toEqual(at(30));
  });

  it('ignores a connection that joined and left in the same instant', () => {
    const session = summariseSession(
      [connection('patient', 10, 10), connection('doctor', 0, 30)],
      NOW,
    );
    expect(session.patient.attended).toBe(true);
    expect(session.patient.connectedSeconds).toBe(0);
    expect(session.durationSeconds).toBe(0);
  });

  /** The row a support query actually turns on: hang-up, or dropped network. */
  it('keeps the disconnect reason LiveKit gave, verbatim', () => {
    const rows: Connection[] = [
      { ...connection('patient', 0, 10), disconnectReason: 'DUPLICATE_IDENTITY' },
    ];
    const session = summariseSession(rows, NOW);
    expect(session.patient.connections).toBe(1);
    expect(rows[0].disconnectReason).toBe('DUPLICATE_IDENTITY');
  });
});

import { Interval } from './intervals';

/**
 * The time a provider's diary already has something in it.
 *
 * M-07 computes bookable slots as availability MINUS what is booked, and what
 * is booked lives in `consultations` (M-11) and, while an instant consult is
 * running, in that same row through `instant_consultancy` (M-13). Neither table
 * exists yet, so this is a port - the same arrangement M-05 used for
 * `SPECIALTY_CATALOGUE` and `DOCTOR_METRICS`.
 *
 * The interval a booking occupies is NOT just its duration. A consultation from
 * 10:00 for thirty minutes with a five-minute buffer occupies 10:00 to 10:35,
 * because the buffer is time the provider is not available to anyone else. The
 * implementation owns that arithmetic, because it is the module holding the
 * duration on the row.
 */
export const BOOKED_INTERVALS = Symbol('BookedIntervals');

export interface BookedIntervals {
  /**
   * Occupied time per provider inside `[from, to)`, keyed by doctor id. A
   * provider with nothing booked may be absent from the map or map to an empty
   * list; callers must treat the two the same.
   *
   * Batched on purpose: the admin's FR-10.7 view and the assignment pool both
   * ask about a whole pool at one instant, and a per-provider call would make
   * that a query per candidate.
   */
  forDoctors(doctorIds: string[], from: Date, to: Date): Promise<Map<string, Interval[]>>;
}

/**
 * *** THERE IS NO DEFAULT IMPLEMENTATION. ***
 *
 * There was one until M-11: a `NoBookedIntervals` that answered "nothing is
 * booked", because `consultations` did not exist and an unimplemented rule must
 * never read as permission. M-11 owns that table now and binds the real reader.
 *
 * The stub is gone rather than kept, so that an unbound port is a BOOT FAILURE
 * rather than a scheduler quietly reporting every provider free all day. A
 * default nothing falls back on is only a way to fail silently later.
 */

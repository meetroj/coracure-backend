/**
 * *** THE ACCESS RULE M-10 CANNOT ANSWER ON ITS OWN. ***
 *
 * M-10 is done when "no file opens for anyone outside that patient's own care".
 * Deciding who is inside that care means reading `consultations`, which M-11
 * owns and which does not exist yet - so this is a port, as
 * `SPECIALTY_CATALOGUE` was for M-05 and `BOOKED_INTERVALS` is for M-07.
 *
 * The default below answers NO to everything, and that direction is the whole
 * point. A stub that guessed "yes" would open every patient's medical history
 * to every signed-in doctor, and it would do it silently, in a build that
 * passed its tests. The conservative answer costs a feature that has no data to
 * work on yet; the optimistic one costs a privacy breach.
 */
export const CONSULTATION_ACCESS = Symbol('ConsultationAccess');

/** The three facts about a consultation that decide a file's access. */
export interface ConsultationContext {
  id: string;
  patientId: string;
  /** Null while an instant request is still searching for a doctor. */
  doctorId: string | null;
  /**
   * Whether the consultation has finished. A patient may not delete a file
   * attached to a completed consultation - by then it is part of a clinical
   * record somebody relied on.
   */
  isCompleted: boolean;
}

export interface ConsultationAccess {
  /** Null when there is no such consultation. */
  contextOf(consultationId: string): Promise<ConsultationContext | null>;

  /**
   * Has this doctor ever consulted this patient?
   *
   * This is what lets a treating doctor read history that predates their own
   * booking (MODULES M-10) without letting any other doctor near it. It is
   * deliberately "ever" and not "currently": a patient's second consultation
   * with the same doctor should not lose sight of the first.
   */
  isTreating(doctorId: string, patientId: string): Promise<boolean>;
}

/**
 * *** THERE IS NO DEFAULT IMPLEMENTATION. ***
 *
 * There was one until M-11: a `NoConsultationAccess` answering "no" to every
 * question, so that no doctor could read any patient's files while
 * `consultations` did not exist. M-11 owns that table now and binds the real
 * answer.
 *
 * The stub is gone rather than kept, so an unbound port is a BOOT FAILURE. A
 * closed default left lying about is something a later change could re-bind by
 * accident, and every doctor-facing read would go quiet with nothing failing.
 */

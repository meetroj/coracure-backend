/**
 * FR-18.6's reliability metrics: acceptance rate, no-show rate and case
 * summary completion.
 *
 * These are COUNTED, never stored. MODULES M-05 is explicit that there are no
 * counter columns on the doctor row, because a counter and the rows it counts
 * can disagree and only one of them is the truth. The rows live in
 * `consultations` (M-11) and `instant_consultancy` (M-13), so this is a port
 * those modules implement.
 */
export const DOCTOR_METRICS = Symbol('DoctorMetrics');

export interface DoctorReliability {
  /** Instant requests accepted / offered. Null while nothing has been offered. */
  acceptanceRate: number | null;
  /** Consultations the doctor did not attend / consultations booked. */
  noShowRate: number | null;
  /** Completed consultations with a finalised case summary / completed consultations. */
  caseSummaryCompletion: number | null;
  consultationsCompleted: number;
}

export interface DoctorMetrics {
  reliabilityOf(doctorId: string): Promise<DoctorReliability>;
}

/**
 * *** THERE IS NO DEFAULT IMPLEMENTATION. ***
 *
 * There was one until M-11, reporting every rate as null because there were no
 * consultations to count. M-11 counts them now. The stub is gone so an unbound
 * port fails at boot rather than showing a dashboard of blanks nobody can
 * explain.
 */

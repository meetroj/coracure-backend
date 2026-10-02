/**
 * "Is this doctor treating this patient?"
 *
 * SRS 6.2: a doctor sees only assigned patients. The answer lives in
 * `consultations`, which M-11 owns - so this is a port, and M-11 supplies the
 * implementation.
 *
 * `DenyAllPatientAssignment` was what this module bound before M-11 existed: it
 * answers no to everything, so a doctor reading a patient profile got a 403
 * rather than a record they might not be entitled to. It is kept as the
 * contract, and as what the tests here exercise - an access rule that is not
 * implemented yet must fail closed.
 */
export const PATIENT_ASSIGNMENT = Symbol('PatientAssignment');

export interface PatientAssignment {
  /** True only where a consultation ties this doctor to this patient. */
  isDoctorTreating(doctorId: string, patientId: string): Promise<boolean>;
}

/**
 * *** THERE IS NO DEFAULT IMPLEMENTATION. ***
 *
 * There was one until M-11: a `DenyAllPatientAssignment` answering no to
 * everything, so a doctor reading a patient profile got a 403 rather than a
 * record they might not be entitled to. M-11 owns `consultations` now and
 * answers it properly.
 *
 * The stub is gone so an unbound port fails at boot. A denial that is quietly
 * re-bound looks exactly like a working access rule until somebody notices no
 * doctor can see any patient.
 */

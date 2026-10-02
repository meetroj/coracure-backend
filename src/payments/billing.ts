/**
 * The bill, in full (FR-7.2).
 *
 * *** EVERY COMPONENT IS SHOWN SEPARATELY. *** FR-7.2 lists them: the doctor's
 * consultation fee, the convenience fee, the subtotal before GST, the GST, and
 * the final payable. A patient who is shown one number cannot tell a fee rise
 * from a tax change, so the shape of this object is part of the requirement.
 */
export interface Bill {
  /** What the SERVICE costs (FR-7.8). The provider keeps all of it (FR-7.4). */
  consultationFee: number;
  convenienceFeePct: number;
  convenienceFee: number;
  /** Derived: fee + convenience. Not stored - it cannot disagree with its parts. */
  subtotal: number;
  gstPct: number;
  gstAmount: number;
  /** Derived: subtotal + GST. What the patient is actually charged. */
  totalPayable: number;
}

/**
 * Rounds to paise-exact rupees.
 *
 * Money is computed in whole paise and divided back at the end, because
 * `500 * 0.2` in floating point is not reliably `100`. Everything below works
 * on integers for exactly that reason, and the two rounded figures - the
 * convenience fee and the GST - are then STORED rather than recomputed later,
 * so a bill can never be reprinted with a different total than the one charged.
 */
function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

function toRupees(paise: number): number {
  return Math.round(paise) / 100;
}

/**
 * FR-7.3's worked example, as code:
 *
 *   fee 500 + convenience 20% (100) -> subtotal 600
 *   GST 18% EXCLUSIVE on the subtotal (108) -> patient pays 708
 *
 * GST is charged on the subtotal rather than on the consultation fee alone.
 * That is what "GST at 18 percent exclusive is 108 rupees" means: 18% of 600,
 * not of 500. Getting this wrong understates the tax on every bill.
 */
export function calculateBill(input: {
  consultationFee: number;
  convenienceFeePct: number;
  gstPct: number;
}): Bill {
  const feePaise = toPaise(input.consultationFee);
  const conveniencePaise = Math.round((feePaise * input.convenienceFeePct) / 100);
  const subtotalPaise = feePaise + conveniencePaise;
  const gstPaise = Math.round((subtotalPaise * input.gstPct) / 100);

  return {
    consultationFee: toRupees(feePaise),
    convenienceFeePct: input.convenienceFeePct,
    convenienceFee: toRupees(conveniencePaise),
    subtotal: toRupees(subtotalPaise),
    gstPct: input.gstPct,
    gstAmount: toRupees(gstPaise),
    totalPayable: toRupees(subtotalPaise + gstPaise),
  };
}

/**
 * The same bill read back from a stored row.
 *
 * The two derived figures are recomputed from the STORED amounts, never from
 * the stored rates - a rate change must not be able to reach an invoice that
 * has already been issued (FR-7.9). The rates on the row are there to be
 * printed, not to be recalculated with.
 */
export function billFromStored(stored: {
  consultationFee: number;
  convenienceFeePct: number;
  convenienceFee: number;
  gstPct: number;
  gstAmount: number;
}): Bill {
  const subtotalPaise = toPaise(stored.consultationFee) + toPaise(stored.convenienceFee);
  return {
    consultationFee: stored.consultationFee,
    convenienceFeePct: stored.convenienceFeePct,
    convenienceFee: stored.convenienceFee,
    subtotal: toRupees(subtotalPaise),
    gstPct: stored.gstPct,
    gstAmount: stored.gstAmount,
    totalPayable: toRupees(subtotalPaise + toPaise(stored.gstAmount)),
  };
}

/**
 * What the PROVIDER is owed (FR-7.4).
 *
 * The deduction is zero and the earning is the whole consultation fee. That is
 * not a placeholder: this release takes nothing from the provider, and the
 * convenience fee and GST are charged ON TOP of their fee rather than out of
 * it. Stating the zero explicitly is the point of the view - a provider seeing
 * only "earning 500" cannot tell whether anything was taken.
 *
 * This is the provider's OWN figure (`doctors.consultation_fee_inr`), which
 * FR-7.9 allows to differ from what the patient was charged for the service.
 */
export interface Payout {
  consultationFee: number;
  platformDeduction: number;
  doctorEarning: number;
  /** `payout_paid_at IS NULL ? pending : paid`. Never a stored status column. */
  status: 'pending' | 'paid';
  paidAt: Date | null;
}

export function payoutOf(consultationFee: number, payoutPaidAt: Date | null): Payout {
  return {
    consultationFee,
    platformDeduction: 0,
    doctorEarning: consultationFee,
    status: payoutPaidAt ? 'paid' : 'pending',
    paidAt: payoutPaidAt,
  };
}

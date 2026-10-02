import { describe, expect, it } from 'vitest';

import { billFromStored, calculateBill, payoutOf } from './billing';

describe('calculateBill', () => {
  it('produces FR-7.3’s worked example exactly', () => {
    // "fee 500, convenience 20% = 100, subtotal 600, GST 18% = 108, payable 708"
    // is written into the SRS as a number, so it is written here as a number.
    expect(calculateBill({ consultationFee: 500, convenienceFeePct: 20, gstPct: 18 })).toEqual({
      consultationFee: 500,
      convenienceFeePct: 20,
      convenienceFee: 100,
      subtotal: 600,
      gstPct: 18,
      gstAmount: 108,
      totalPayable: 708,
    });
  });

  it('charges GST on the SUBTOTAL, not on the consultation fee alone', () => {
    // 18% of 600 is 108; 18% of 500 would be 90. Getting this wrong understates
    // the tax on every bill the platform issues.
    const bill = calculateBill({ consultationFee: 500, convenienceFeePct: 20, gstPct: 18 });
    expect(bill.gstAmount).toBe(108);
    expect(bill.gstAmount).not.toBe(90);
  });

  it('keeps the parts adding up to the whole', () => {
    for (const fee of [0, 1, 99.99, 350, 777.77, 12345.67]) {
      const bill = calculateBill({ consultationFee: fee, convenienceFeePct: 20, gstPct: 18 });
      expect(bill.subtotal).toBeCloseTo(bill.consultationFee + bill.convenienceFee, 2);
      expect(bill.totalPayable).toBeCloseTo(bill.subtotal + bill.gstAmount, 2);
    }
  });

  it('is exact on a fee that floating point would fumble', () => {
    // 0.1 + 0.2 arithmetic in a bill is how a patient is charged a paisa more
    // than the invoice says.
    const bill = calculateBill({ consultationFee: 0.1, convenienceFeePct: 20, gstPct: 18 });
    expect(bill.convenienceFee).toBe(0.02);
    expect(bill.totalPayable).toBe(0.14);
  });

  it('handles a free service without inventing tax on nothing', () => {
    const bill = calculateBill({ consultationFee: 0, convenienceFeePct: 20, gstPct: 18 });
    expect(bill).toMatchObject({ convenienceFee: 0, gstAmount: 0, totalPayable: 0 });
  });

  it('handles a zero convenience fee and a zero GST rate', () => {
    const bill = calculateBill({ consultationFee: 500, convenienceFeePct: 0, gstPct: 0 });
    expect(bill).toMatchObject({
      convenienceFee: 0,
      subtotal: 500,
      gstAmount: 0,
      totalPayable: 500,
    });
  });
});

describe('billFromStored', () => {
  it('reprints exactly what was charged', () => {
    const stored = {
      consultationFee: 500,
      convenienceFeePct: 20,
      convenienceFee: 100,
      gstPct: 18,
      gstAmount: 108,
    };
    expect(billFromStored(stored).totalPayable).toBe(708);
  });

  it('*** ignores a later rate change ***, because an invoice is frozen (FR-7.9)', () => {
    // The row was billed at 20% convenience. `app_config` may now say 25%. The
    // stored AMOUNTS are what is added up; the stored RATES are only printed.
    const stored = {
      consultationFee: 500,
      convenienceFeePct: 20,
      convenienceFee: 100,
      gstPct: 18,
      gstAmount: 108,
    };
    const reprinted = billFromStored(stored);
    const recalculated = calculateBill({ consultationFee: 500, convenienceFeePct: 25, gstPct: 18 });

    expect(reprinted.totalPayable).toBe(708);
    expect(recalculated.totalPayable).not.toBe(708);
  });
});

describe('payoutOf', () => {
  it('produces FR-7.4’s view: fee 500, deduction 0, earning 500', () => {
    expect(payoutOf(500, null)).toEqual({
      consultationFee: 500,
      platformDeduction: 0,
      doctorEarning: 500,
      status: 'pending',
      paidAt: null,
    });
  });

  it('states the zero deduction rather than leaving it out', () => {
    // A provider shown only "earning 500" cannot tell whether anything was
    // taken. The zero is the reassurance.
    expect(payoutOf(500, null)).toHaveProperty('platformDeduction', 0);
  });

  it('reads the payout status from the timestamp, never a status column', () => {
    const when = new Date('2026-09-20T00:00:00.000Z');
    expect(payoutOf(500, when)).toMatchObject({ status: 'paid', paidAt: when });
  });
});

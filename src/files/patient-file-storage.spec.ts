import { describe, expect, it } from 'vitest';

import { keyBelongsToPatient, patientFileKey } from './patient-file-storage';

describe('patientFileKey', () => {
  it('puts every file under the patient it belongs to', () => {
    const key = patientFileKey('patient-1', 'report', 'blood.pdf');
    expect(key.startsWith('patient-files/patient-1/report/')).toBe(true);
  });

  it('keeps patient files in a different prefix from doctor credentials', () => {
    // Separate prefixes are not decoration: a bucket policy, a lifecycle rule
    // or a retention job can then treat somebody's identity document and
    // somebody's blood report differently.
    expect(patientFileKey('patient-1', 'report', 'x.pdf')).not.toContain('doctor-documents');
  });

  it('never reuses a key, so an upload cannot overwrite an earlier one', () => {
    const first = patientFileKey('patient-1', 'report', 'blood.pdf');
    const second = patientFileKey('patient-1', 'report', 'blood.pdf');
    expect(first).not.toBe(second);
  });

  it("keeps the extension but not the caller's file name", () => {
    // The name is clinical detail. It belongs on the download, not in a key
    // that ends up in bucket listings and access logs.
    const key = patientFileKey('patient-1', 'report', 'hiv results final.PDF');
    expect(key.endsWith('.pdf')).toBe(true);
    expect(key).not.toContain('hiv');
  });

  it('cannot be walked out of the prefix by a hostile file name', () => {
    const key = patientFileKey('patient-1', 'photo', '../../doctor-documents/x');
    expect(key).not.toContain('..');
    expect(key.startsWith('patient-files/patient-1/')).toBe(true);
  });
});

describe('keyBelongsToPatient', () => {
  it('accepts a key minted for that patient', () => {
    expect(keyBelongsToPatient(patientFileKey('patient-1', 'report', 'a.pdf'), 'patient-1')).toBe(
      true,
    );
  });

  it("refuses another patient's key", () => {
    expect(keyBelongsToPatient(patientFileKey('patient-2', 'report', 'a.pdf'), 'patient-1')).toBe(
      false,
    );
  });

  it('refuses a key that only starts with the patient id', () => {
    // `patient-files/patient-10/...` must not pass for `patient-1`.
    expect(keyBelongsToPatient('patient-files/patient-10/report/a.pdf', 'patient-1')).toBe(false);
  });

  it('refuses a doctor credential key outright', () => {
    expect(keyBelongsToPatient('doctor-documents/patient-1/report/a.pdf', 'patient-1')).toBe(false);
  });
});

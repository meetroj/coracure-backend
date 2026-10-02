import { describe, expect, it } from 'vitest';

import { credentialKey, keyBelongsToDoctor } from './credential-storage';

describe('credentialKey', () => {
  it('puts every file under the doctor it belongs to', () => {
    const key = credentialKey('doctor-1', 'degree_certificate', 'degree.pdf');
    expect(key.startsWith('doctor-documents/doctor-1/degree_certificate/')).toBe(true);
  });

  it('never reuses a key, so an upload cannot overwrite an earlier one', () => {
    const first = credentialKey('doctor-1', 'identity_proof', 'id.png');
    const second = credentialKey('doctor-1', 'identity_proof', 'id.png');
    expect(first).not.toBe(second);
  });

  it("keeps the extension but not the caller's file name", () => {
    const key = credentialKey('doctor-1', 'identity_proof', 'my passport scan.PNG');
    expect(key.endsWith('.png')).toBe(true);
    expect(key).not.toContain('passport');
  });

  it('cannot be walked out of the prefix by a hostile file name', () => {
    const key = credentialKey('doctor-1', 'other', '../../etc/passwd');
    expect(key).not.toContain('..');
    expect(key.startsWith('doctor-documents/doctor-1/')).toBe(true);
  });
});

describe('keyBelongsToDoctor', () => {
  it('accepts a key minted for that doctor', () => {
    const key = credentialKey('doctor-1', 'degree_certificate', 'degree.pdf');
    expect(keyBelongsToDoctor(key, 'doctor-1')).toBe(true);
  });

  it("refuses another doctor's key", () => {
    const key = credentialKey('doctor-2', 'degree_certificate', 'degree.pdf');
    expect(keyBelongsToDoctor(key, 'doctor-1')).toBe(false);
  });

  it('refuses a key that only starts with the id, without the separator', () => {
    expect(keyBelongsToDoctor('doctor-documents/doctor-10/other/x.pdf', 'doctor-1')).toBe(false);
  });

  it('refuses a key from outside the credential prefix entirely', () => {
    expect(keyBelongsToDoctor('patient-files/doctor-1/x.pdf', 'doctor-1')).toBe(false);
  });
});

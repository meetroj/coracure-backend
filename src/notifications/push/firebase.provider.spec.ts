import { describe, expect, it } from 'vitest';

import { parseServiceAccount } from './firebase.provider';

const ACCOUNT = {
  type: 'service_account',
  project_id: 'coracure-patient',
  client_email: 'firebase-adminsdk@coracure-patient.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n',
};

describe('parseServiceAccount', () => {
  it('reads the JSON Google hands you, unchanged', () => {
    const parsed = parseServiceAccount(JSON.stringify(ACCOUNT));
    expect(parsed.projectId).toBe('coracure-patient');
    expect(parsed.clientEmail).toBe(ACCOUNT.client_email);
  });

  it('reads the same JSON base64-encoded', () => {
    // What survives most secret managers and CI variables with its newlines
    // intact. Both forms have to work, or a deployment fails on the format
    // somebody happened to paste.
    const encoded = Buffer.from(JSON.stringify(ACCOUNT)).toString('base64');
    expect(parseServiceAccount(encoded).projectId).toBe('coracure-patient');
  });

  it('restores newlines a shell or a JSON string escaped away', () => {
    // A private key that lost its newlines fails at the first send, with an
    // error that reads like a permissions problem and sends you the wrong way.
    const escaped = JSON.stringify({
      ...ACCOUNT,
      private_key: '-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n',
    });
    expect(parseServiceAccount(escaped).privateKey).toBe(ACCOUNT.private_key);
  });

  it('accepts the camelCase spelling too', () => {
    const parsed = parseServiceAccount(
      JSON.stringify({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
    );
    expect(parsed).toMatchObject({ projectId: 'p', clientEmail: 'e', privateKey: 'k' });
  });

  it('says which field is missing rather than failing later at send time', () => {
    expect(() => parseServiceAccount(JSON.stringify({ project_id: 'p' }))).toThrow(
      /project_id, client_email or private_key/,
    );
  });

  it('rejects something that is not a service account at all', () => {
    expect(() => parseServiceAccount('not json')).toThrow();
  });
});

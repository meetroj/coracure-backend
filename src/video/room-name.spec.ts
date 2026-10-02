import { describe, expect, it } from 'vitest';

import { consultationIdFrom, identityFor, partyFrom, roomNameFor } from './room-name';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('the room name (the column that is not there)', () => {
  it('names a room from the consultation id', () => {
    expect(roomNameFor(ID)).toBe(`consultation-${ID}`);
  });

  /**
   * The property the missing `livekit_room_name` column relies on. If the
   * mapping were not reversible the webhook could not find its consultation,
   * and a stored name would become the only way back.
   */
  it('round-trips, so a webhook can find its consultation from the room alone', () => {
    expect(consultationIdFrom(roomNameFor(ID))).toBe(ID);
  });

  it('names one room per consultation, and always the same one', () => {
    expect(roomNameFor(ID)).toBe(roomNameFor(ID.toUpperCase()));
  });

  /**
   * Null, not a throw: this parses a string that arrived in a webhook from
   * outside. A LiveKit instance shared with a load test or a later product
   * delivers events for rooms this module never named, and those are ignored.
   */
  it.each([
    ['a room that is not ours', 'lobby'],
    ['our prefix with something that is not a uuid', 'consultation-not-a-uuid'],
    ['the prefix alone', 'consultation-'],
    ['an empty name', ''],
    // Path traversal dressed as a room name. It is not a uuid, so it is not
    // one of ours, and nothing downstream ever sees it.
    ['a name trying to be something else', 'consultation-../../etc/passwd'],
  ])('refuses %s', (_case, name) => {
    expect(consultationIdFrom(name)).toBeNull();
  });
});

describe('the participant identity', () => {
  /**
   * The identity is the PARTY, never the account id: which patient and which
   * doctor is already on the consultation row, and an id in the identity would
   * repeat a foreign key into the media plane where the other participant and
   * LiveKit's logs can both read it.
   */
  it('names the side of the consultation, not the person', () => {
    expect(identityFor('patient')).toBe('patient');
    expect(identityFor('doctor')).toBe('doctor');
  });

  it('round-trips', () => {
    expect(partyFrom(identityFor('patient'))).toBe('patient');
    expect(partyFrom(identityFor('doctor'))).toBe('doctor');
  });

  /**
   * `Party` has four values and only two can ever be in a call. An `admin` or
   * `system` row would mean a third party was in a clinical consultation, so
   * the translation refuses it here as well as the database CHECK refusing it
   * on the way in.
   */
  it.each(['admin', 'system', 'Patient', 'doctor ', '', 'patient-1'])(
    'refuses %o as a call participant',
    (identity) => {
      expect(partyFrom(identity)).toBeNull();
    },
  );
});

import { Party } from '@prisma/client';

/**
 * *** THE ROOM IS NOT A ROW. ***
 *
 * `consultations` has no `livekit_room_name`, because a name derived from the
 * id is not a second fact - it is the same fact written differently. Storing it
 * would create a column that can disagree with the row it belongs to, and would
 * let two rooms exist for one consultation, which is precisely what FR-8.5's
 * "a room per consultation" forbids.
 *
 * Derivation instead of storage also means the mapping is total in both
 * directions: every consultation has a room, every room names a consultation,
 * and the webhook can find its consultation from nothing but the room name.
 */

const ROOM_PREFIX = 'consultation-';

/** Lowercase canonical uuid, which is the only form `gen_random_uuid()` emits. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The LiveKit room for a consultation. Pure, total, and never stored. */
export function roomNameFor(consultationId: string): string {
  return `${ROOM_PREFIX}${consultationId.toLowerCase()}`;
}

/**
 * The consultation a room belongs to, or null if the name is not one of ours.
 *
 * Null rather than a throw: this parses a string that arrived from OUTSIDE, in
 * a webhook. A LiveKit instance shared with anything else - a load test, a
 * demo, a later product - would deliver events for rooms this module has never
 * heard of, and those are ignored, not errors.
 */
export function consultationIdFrom(roomName: string): string | null {
  if (!roomName.startsWith(ROOM_PREFIX)) return null;
  const id = roomName.slice(ROOM_PREFIX.length);
  return UUID.test(id) ? id : null;
}

/**
 * *** THE PARTICIPANT IDENTITY IS THE PARTY, NOT THE PERSON. ***
 *
 * `patient` and `doctor` - not the account uuid. Three reasons, in order of
 * how much they matter:
 *
 * 1. WHICH patient and WHICH doctor is already on the consultation row, and the
 *    room is one consultation. Putting an account id in the identity repeats a
 *    foreign key into the media plane, where it is visible to the other
 *    participant and to LiveKit's logs, and buys nothing.
 * 2. LiveKit treats identity as unique within a room: a second connection with
 *    the same identity disconnects the first with DUPLICATE_IDENTITY. That is
 *    exactly the behaviour a consultation wants when a patient rejoins from a
 *    second device - one patient, one connection - and the reason lands in
 *    `consultation_participants.disconnect_reason` where a later complaint can
 *    read it.
 * 3. With `max_participants: 2` in livekit.yaml and only two possible
 *    identities, "no third party in a clinical call" holds in the media plane
 *    as well as in the token issuer and in the database CHECK.
 */
export function identityFor(party: Party): string {
  return party;
}

/**
 * The party a LiveKit identity names, or null if it names neither.
 *
 * The narrowing matters: `Party` has four values and this returns only two, so
 * an `admin` or `system` row cannot be written by mistranslating a webhook. The
 * database refuses those anyway - this is the same rule stated where the value
 * enters the system rather than where it lands.
 */
export function partyFrom(identity: string): Extract<Party, 'patient' | 'doctor'> | null {
  if (identity === Party.patient || identity === Party.doctor) return identity;
  return null;
}

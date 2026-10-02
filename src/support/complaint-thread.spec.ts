import { describe, expect, it } from 'vitest';

import {
  ComplaintMessage,
  canWrite,
  isTerminal,
  parseMessages,
  patientVisible,
} from './complaint-thread';

const message = (over: Partial<ComplaintMessage> = {}): ComplaintMessage => ({
  authorId: 'admin-1',
  authorRole: 'admin',
  body: 'Looking into this now.',
  isInternal: false,
  at: '2026-09-19T10:00:00.000Z',
  ...over,
});

/**
 * *** THE ONE RULE THAT REALLY MATTERS IN M-19. ***
 *
 * An admin needs somewhere to write "spoke to the provider, they dispute this"
 * while a ticket is open. That note going to the patient would be a serious
 * failure, so the filter is tested on its own — no database, no HTTP layer.
 */
describe('what the patient may read', () => {
  it('keeps the messages meant for them', () => {
    const thread = [message(), message({ authorRole: 'patient', authorId: 'patient-1' })];
    expect(patientVisible(thread)).toHaveLength(2);
  });

  it('drops an internal note', () => {
    const thread = [
      message({ body: 'Thanks for getting in touch.' }),
      message({ body: 'Provider disputes the account.', isInternal: true }),
    ];
    const visible = patientVisible(thread);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.body).toBe('Thanks for getting in touch.');
  });

  /**
   * *** IT FAILS TOWARDS SHOWING TOO LITTLE. ***
   *
   * A positive filter — keep what is explicitly NOT internal — rather than a
   * subtraction. A `filter(m => !m.isInternal)` would KEEP an entry whose flag
   * was missing or the wrong type, and when the failure mode is "the patient
   * reads the admin's private note about them", the safe direction is to drop it.
   */
  it.each([
    ['a missing flag', { isInternal: undefined }],
    ['a string instead of a boolean', { isInternal: 'false' }],
    ['a null', { isInternal: null }],
    ['a truthy string', { isInternal: 'no' }],
  ])('drops a message with %s', (_case, broken) => {
    const thread = [{ ...message(), ...broken } as unknown as ComplaintMessage];
    expect(patientVisible(thread)).toEqual([]);
  });

  it('leaves an empty thread empty', () => {
    expect(patientVisible([])).toEqual([]);
  });
});

describe('reading a stored thread back', () => {
  it('round-trips a well-formed thread', () => {
    const thread = [message(), message({ isInternal: true })];
    expect(parseMessages(thread)).toHaveLength(2);
  });

  /** jsonb is only as good as what wrote it. A broken thread reads as empty. */
  it.each([
    ['not an array', { authorId: 'a' }],
    ['a bare string', 'hello'],
    ['an entry missing its author', [{ body: 'x', isInternal: false, at: 'now' }]],
    ['an entry with an unknown role', [{ ...message(), authorRole: 'doctor' }]],
  ])('returns nothing for %s', (_case, stored) => {
    expect(parseMessages(stored)).toEqual([]);
  });
});

describe('when a complaint may still be written on', () => {
  it.each(['open', 'in_progress'] as const)('allows writing while %s', (status) => {
    expect(canWrite(status)).toBe(true);
    expect(isTerminal(status)).toBe(false);
  });

  /**
   * Not silencing the patient: a reply to a decision is an escalation, and an
   * escalation that looks like a reply on a closed ticket is one nobody is
   * watching. A new complaint queues where somebody will see it.
   */
  it.each(['resolved', 'rejected'] as const)('refuses writing once %s', (status) => {
    expect(canWrite(status)).toBe(false);
    expect(isTerminal(status)).toBe(true);
  });

  /** `rejected` is terminal but NOT resolved. FR-18.6 counts the two apart. */
  it('treats rejection as an ending in its own right', () => {
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('resolved')).toBe(true);
    expect(canWrite('rejected')).toBe(false);
  });
});

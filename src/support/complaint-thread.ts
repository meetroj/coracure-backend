import { ComplaintStatus } from '@prisma/client';
import * as z from 'zod';

/**
 * The conversation on a complaint, and the states it moves through.
 *
 * Kept apart from the service so the one rule that really matters here - which
 * messages a patient may read - can be tested on its own, without a database
 * and without an HTTP layer in the way.
 */

export const messageSchema = z.object({
  authorId: z.string().min(1).max(64),
  authorRole: z.enum(['patient', 'admin']),
  body: z.string().min(1).max(4000),
  /**
   * *** THE ONE FLAG THAT DECIDES WHO READS THIS. ***
   *
   * An admin needs somewhere to write "spoke to the provider, they dispute
   * this" while the ticket is open. Without an internal note that thinking
   * happens in email, where it is invisible to the next person to pick the
   * ticket up - so the note belongs on the ticket, and the patient must not
   * see it.
   *
   * A patient's own message is never internal; the service refuses to set it.
   */
  isInternal: z.boolean(),
  /** ISO instant. Written by the server, never taken from a client. */
  at: z.string().min(1).max(40),
});

export type ComplaintMessage = z.infer<typeof messageSchema>;

export const messagesSchema = z.array(messageSchema).max(200);

/** Parsed out of jsonb. A thread that will not parse reads as empty. */
export function parseMessages(value: unknown): ComplaintMessage[] {
  const parsed = messagesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * *** WHAT THE PATIENT IS ALLOWED TO READ. ***
 *
 * A positive filter - keep what is NOT internal - rather than a subtraction.
 * The difference matters: a message that arrives with `isInternal` missing or
 * malformed is dropped by this and would be KEPT by a `filter(m => !m.internal)`
 * written against a slightly different field name. When the failure mode is
 * "the patient reads the admin's private note about them", the filter should
 * fail towards showing too little.
 */
export function patientVisible(messages: ComplaintMessage[]): ComplaintMessage[] {
  return messages.filter((message) => message.isInternal === false);
}

/**
 * *** THE COMPLAINT WORKFLOW (FR-18.8). ***
 *
 *   open ──an admin picks it up──► in_progress
 *     │                                │
 *     └────────────────┬───────────────┘
 *                      │
 *          ┌───────────┴───────────┐
 *          ▼                       ▼
 *      resolved                rejected
 *
 * Both endings are terminal and both need a note. Neither can be reached
 * without an assignee, because somebody has to own the decision.
 */

/** A complaint is still live in these two. Everything else is finished. */
export const OPEN_STATES: ComplaintStatus[] = [ComplaintStatus.open, ComplaintStatus.in_progress];

/** The two endings. Reachable from either open state. */
export const TERMINAL_STATES: ComplaintStatus[] = [
  ComplaintStatus.resolved,
  ComplaintStatus.rejected,
];

export function isTerminal(status: ComplaintStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Anybody may still write while it is open.
 *
 * A patient may NOT reopen a closed complaint by replying to it. That is not
 * silencing them - it is that a reply to a decision is an escalation, and an
 * escalation that looks like a reply on a closed ticket is one nobody is
 * watching. They raise a new complaint, which lands in the queue.
 */
export function canWrite(status: ComplaintStatus): boolean {
  return OPEN_STATES.includes(status);
}

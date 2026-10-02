import { ClarificationStatus } from '@prisma/client';
import * as z from 'zod';

/**
 * The discussion on a case, and the states it moves through.
 *
 * Kept apart from the service so the status machine can be read in one screen
 * and tested without a database. FR-12.6 names seven states, and the value of
 * naming them is lost if the transitions between them are scattered through
 * five methods.
 */

/**
 * FR-12.5's four, plus the treating doctor's reply.
 *
 * An enum rather than free text because the KIND is what the treating doctor
 * triages by: "the expert wants something more from me" and "the expert has
 * advised bringing follow-up forward" demand different things on different
 * timescales, and reading a paragraph to find out which is not triage.
 */
export const MESSAGE_TYPES = [
  /** General remarks on the case. */
  'comment',
  /** Something to weigh clinically. FR-12.5's "clinical considerations". */
  'clinical_consideration',
  /** The expert cannot answer without more. Moves the case back to the author. */
  'clarification_request',
  /** Advice to bring follow-up forward, or to see the patient in person. */
  'followup_recommendation',
  /** The treating doctor answering a clarification request. */
  'author_reply',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export const messageSchema = z.object({
  /** The doctor who wrote it - author or expert. Never a patient. */
  authorId: z.string().min(1).max(64),
  authorRole: z.enum(['treating_doctor', 'expert']),
  messageType: z.enum(MESSAGE_TYPES),
  body: z.string().min(1).max(4000),
  /** ISO instant. Written by the server, never taken from a client. */
  at: z.string().min(1).max(40),
});

export type CaseMessage = z.infer<typeof messageSchema>;

export const messagesSchema = z.array(messageSchema).max(200);

/** Parsed out of jsonb. A thread that will not parse reads as empty. */
export function parseMessages(value: unknown): CaseMessage[] {
  const parsed = messagesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * *** THE STATUS MACHINE (FR-12.6). ***
 *
 *   draft ──post──► posted ──assign──► awaiting_response
 *                                              │
 *                        ┌─────────────────────┤
 *                        │                     │
 *              clarification_request     comment / consideration
 *                        │                / recommendation
 *                        ▼                     ▼
 *              clarification_asked      response_received
 *                        │                     │
 *                   author_reply          mark reviewed
 *                        │                     │
 *                        ▼                     ▼
 *              awaiting_response ──►      reviewed ──close──► closed
 *
 * Closing is reachable from anywhere past draft, because a case can stop
 * mattering at any point - the patient improves, or is admitted, and chasing an
 * opinion nobody needs any more helps nobody.
 */

/** What an expert's message does to the case's status. */
export function statusAfterExpertMessage(messageType: MessageType): ClarificationStatus {
  return messageType === 'clarification_request'
    ? ClarificationStatus.clarification_asked
    : ClarificationStatus.response_received;
}

/** The states in which the expert may still write. */
export const EXPERT_MAY_WRITE: ClarificationStatus[] = [
  ClarificationStatus.awaiting_response,
  // They may add to an answer they have already given, and may follow up on a
  // clarification they asked for without waiting to be answered.
  ClarificationStatus.response_received,
  ClarificationStatus.clarification_asked,
];

/** The states in which the treating doctor may still write. */
export const AUTHOR_MAY_WRITE: ClarificationStatus[] = [
  ClarificationStatus.awaiting_response,
  ClarificationStatus.response_received,
  ClarificationStatus.clarification_asked,
  ClarificationStatus.reviewed,
];

/** Editing the snapshot. Only before anybody has been shown it. */
export const EDITABLE: ClarificationStatus[] = [ClarificationStatus.draft];

/** A case may be closed from anywhere it has actually started. */
export const CLOSEABLE: ClarificationStatus[] = [
  ClarificationStatus.posted,
  ClarificationStatus.awaiting_response,
  ClarificationStatus.response_received,
  ClarificationStatus.clarification_asked,
  ClarificationStatus.reviewed,
];

/** Assignable: posted and not yet with anybody, or being moved to a new expert. */
export const ASSIGNABLE: ClarificationStatus[] = [
  ClarificationStatus.posted,
  ClarificationStatus.awaiting_response,
  ClarificationStatus.response_received,
  ClarificationStatus.clarification_asked,
];

/**
 * Marking a case reviewed says the treating doctor has read the advice and
 * weighed it. Only once there is advice to weigh - a case nobody has answered
 * cannot have been considered.
 */
export const REVIEWABLE: ClarificationStatus[] = [
  ClarificationStatus.response_received,
  ClarificationStatus.clarification_asked,
];

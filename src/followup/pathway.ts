import { CheckinStatus } from '@prisma/client';
import * as z from 'zod';

/**
 * *** THE SHAPE OF A CLINICIAN-APPROVED QUESTION SET. ***
 *
 * Held as jsonb on the pathway row rather than as code, because FR-13.7 puts
 * the wording and the rules in the admin panel with no app release behind them:
 * a question that turns out to be misleading, or a rule that turns out to fire
 * too often, has to be fixable this afternoon for patients who are mid-follow-up.
 *
 * That means this file cannot trust its input the way it could trust a
 * constant. Everything here is parsed, and a pathway that will not parse is
 * refused at the point an admin saves it rather than at the point a patient
 * answers it.
 */

/** What one answer contributes. Red is reserved for the rules, not the options. */
export const OPTION_FLAGS = ['green', 'amber'] as const;

const optionSchema = z.object({
  /** Stored in the answers. Stable across wording changes within a version. */
  value: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  /**
   * What choosing this contributes to the day's status. Absent means green.
   *
   * There is deliberately no `red` here. A red status is a SAFETY finding and
   * comes only from `redFlagRules`, which carry the plain-words reason an alert
   * is raised with - an option that could silently force red would produce an
   * alert nobody could explain.
   */
  flag: z.enum(OPTION_FLAGS).optional(),
});

export const QUESTION_TYPES = ['single_choice', 'scale', 'yes_no', 'text'] as const;

const questionSchema = z.object({
  /** Keys the answer. Stable within a version, which is why versions are whole. */
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and underscores'),
  text: z.string().min(1).max(300),
  type: z.enum(QUESTION_TYPES),
  /** Required for a choice; meaningless for free text. */
  options: z.array(optionSchema).max(10).optional(),
  /** A skipped optional question is not a missed check-in. */
  required: z.boolean().optional(),
});

export type CheckinQuestion = z.infer<typeof questionSchema>;
export type CheckinOption = z.infer<typeof optionSchema>;

/**
 * FR-13.5's seven categories, and nothing else.
 *
 * A closed list because each one is a clinical finding the client's clinician
 * has signed off, and because the category is what an admin queue is triaged
 * by. An admin editing a pathway picks from these; they cannot invent an
 * eighth kind of emergency.
 */
export const RED_FLAG_CATEGORIES = [
  'self_harm',
  'severe_worsening',
  'confusion_or_agitation',
  'violence_risk',
  'severe_withdrawal',
  'medication_side_effect',
  'feeling_unsafe',
] as const;

export type RedFlagCategory = (typeof RED_FLAG_CATEGORIES)[number];

const redFlagRuleSchema = z.object({
  questionId: z.string().min(1).max(60),
  /**
   * Any of these answers fires the rule. A list rather than one value because
   * "much worse" and "very much worse" are one finding, and writing them as two
   * rules would produce two alerts for one answer.
   */
  whenAnswerIn: z.array(z.string().min(1).max(60)).min(1).max(10),
  category: z.enum(RED_FLAG_CATEGORIES),
  /**
   * The plain-words reason the alert carries. NEVER a diagnosis: it is read on
   * a lock screen and in an admin queue, by people who may not be the patient.
   */
  reason: z.string().min(1).max(255),
});

export type RedFlagRule = z.infer<typeof redFlagRuleSchema>;

export const questionsSchema = z.array(questionSchema).min(1).max(20);
export const redFlagRulesSchema = z.array(redFlagRuleSchema).max(40);

/** An answer is a single value or, for a multi-select, several. */
export const answersSchema = z.record(
  z.string().min(1).max(60),
  z.union([z.string().max(2000), z.array(z.string().max(60)).max(10), z.number(), z.boolean()]),
);

export type Answers = z.infer<typeof answersSchema>;

/** What a day's check-in came to, and why. */
export interface Evaluation {
  status: CheckinStatus;
  /** Every red-flag rule that fired, in the order the rules are written. */
  redFlags: { category: RedFlagCategory; reason: string; questionId: string }[];
  /** Questions whose chosen option contributed amber. Plain question ids. */
  amberFrom: string[];
  /** Required questions of the APPROVED set left unanswered. */
  unanswered: string[];
}

/** Every form an answer can take, flattened to the values a rule compares against. */
function valuesOf(answer: Answers[string] | undefined): string[] {
  if (answer === undefined || answer === null) return [];
  if (Array.isArray(answer)) return answer.map(String);
  return [String(answer)];
}

function isAnswered(answer: Answers[string] | undefined): boolean {
  return valuesOf(answer).some((value) => value.trim().length > 0);
}

/**
 * *** THE SAFETY EVALUATION. FR-13.2 TO FR-13.5. ***
 *
 * Pure, and given the pathway rather than reading one, so the rules that
 * decided a status can be replayed exactly from the pinned version and the
 * stored answers. That is why `checkin_responses` stores no `triggered_rules`:
 * this function IS the record of how a status was reached.
 *
 * Red wins outright and is never diluted. There is no arithmetic over
 * severities, no scoring and no threshold: one clinician-approved red-flag rule
 * firing is a red day, however green everything else was. A patient reporting
 * thoughts of self-harm alongside better sleep is not an amber.
 *
 * @param questions the PINNED pathway's set. Doctor-added questions are NOT
 *   passed here - see `withoutDoctorQuestions`.
 */
export function evaluate(
  questions: CheckinQuestion[],
  rules: RedFlagRule[],
  answers: Answers,
): Evaluation {
  const redFlags: Evaluation['redFlags'] = [];
  for (const rule of rules) {
    const given = valuesOf(answers[rule.questionId]);
    if (given.some((value) => rule.whenAnswerIn.includes(value))) {
      redFlags.push({
        category: rule.category,
        reason: rule.reason,
        questionId: rule.questionId,
      });
    }
  }

  const amberFrom: string[] = [];
  const unanswered: string[] = [];
  for (const question of questions) {
    const given = valuesOf(answers[question.id]);
    if (question.required && !isAnswered(answers[question.id])) {
      unanswered.push(question.id);
      continue;
    }
    const amber = (question.options ?? []).some(
      (option) => option.flag === 'amber' && given.includes(option.value),
    );
    if (amber) amberFrom.push(question.id);
  }

  const status =
    redFlags.length > 0
      ? CheckinStatus.red
      : amberFrom.length > 0
        ? CheckinStatus.amber
        : CheckinStatus.green;

  return { status, redFlags, amberFrom, unanswered };
}

/**
 * *** FR-13.8. THE RULE THAT KEEPS SAFETY ON THE APPROVED SET. ***
 *
 * "Doctor-added questions collect answers only. They carry no red-flag rules,
 * so safety alerting stays on the clinician-approved set."
 *
 * A doctor may add questions for one patient. Those answers are stored and
 * shown, and they must never influence a status - otherwise the safety net
 * would differ per patient, and a red flag would mean something different
 * depending on who was treating them.
 *
 * Enforced by CONSTRUCTION rather than by a check: the doctor's questions are
 * filtered out before the evaluator ever sees them, so there is no path by
 * which one could be graded. The evaluator has no idea they exist.
 */
export function withoutDoctorQuestions(
  pathwayQuestions: CheckinQuestion[],
  doctorQuestions: CheckinQuestion[],
): CheckinQuestion[] {
  const added = new Set(doctorQuestions.map((question) => question.id));
  return pathwayQuestions.filter((question) => !added.has(question.id));
}

/** The whole set a patient is shown: the approved one, then the doctor's. */
export function questionsFor(
  pathwayQuestions: CheckinQuestion[],
  doctorQuestions: CheckinQuestion[],
): (CheckinQuestion & { addedByDoctor: boolean })[] {
  const added = new Set(doctorQuestions.map((question) => question.id));
  return [
    ...pathwayQuestions
      .filter((question) => !added.has(question.id))
      .map((question) => ({ ...question, addedByDoctor: false })),
    // Marked, so the app can label them and so nobody later mistakes one for
    // part of the clinician-approved set.
    ...doctorQuestions.map((question) => ({ ...question, addedByDoctor: true })),
  ];
}

/** Parsed out of jsonb. A stored set that will not parse grades nothing. */
export function parseQuestions(value: unknown): CheckinQuestion[] {
  const parsed = questionsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function parseRules(value: unknown): RedFlagRule[] {
  const parsed = redFlagRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** A doctor's extra questions, which may legitimately be an empty list. */
export function parseDoctorQuestions(value: unknown): CheckinQuestion[] {
  const parsed = z.array(questionSchema).max(10).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * The day of the follow-up a date falls on, counting the start day as day 1.
 * Returns 0 or less before it starts, and more than `durationDays` after it ends.
 */
export function followupDay(startsOn: Date, on: Date): number {
  const day = 24 * 60 * 60 * 1000;
  const from = Date.UTC(startsOn.getUTCFullYear(), startsOn.getUTCMonth(), startsOn.getUTCDate());
  const to = Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate());
  return Math.round((to - from) / day) + 1;
}

/** `followup_starts_on` + `duration_days`. Never a stored column. */
export function followupEndsOn(startsOn: Date, durationDays: number): Date {
  const end = new Date(startsOn);
  end.setUTCDate(end.getUTCDate() + durationDays - 1);
  return end;
}

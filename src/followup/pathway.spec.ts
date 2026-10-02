import { describe, expect, it } from 'vitest';

import { DEFAULT_PATHWAYS } from './default-pathways';
import {
  CheckinQuestion,
  RedFlagRule,
  evaluate,
  followupDay,
  followupEndsOn,
  parseQuestions,
  parseRules,
  questionsFor,
  questionsSchema,
  redFlagRulesSchema,
  withoutDoctorQuestions,
} from './pathway';

const MOOD: CheckinQuestion = {
  id: 'mood',
  text: 'How has your mood been?',
  type: 'single_choice',
  required: true,
  options: [
    { value: 'better', label: 'Better' },
    { value: 'same', label: 'About the same' },
    { value: 'worse', label: 'Worse', flag: 'amber' },
    { value: 'much_worse', label: 'Much worse', flag: 'amber' },
  ],
};

const SELF_HARM: CheckinQuestion = {
  id: 'self_harm',
  text: 'Thoughts of harming yourself?',
  type: 'single_choice',
  required: true,
  options: [
    { value: 'no', label: 'No' },
    { value: 'yes', label: 'Yes' },
  ],
};

const SELF_HARM_RULE: RedFlagRule = {
  questionId: 'self_harm',
  whenAnswerIn: ['yes'],
  category: 'self_harm',
  reason: 'Reported thoughts of self-harm on the daily check-in.',
};

const WORSENING_RULE: RedFlagRule = {
  questionId: 'mood',
  whenAnswerIn: ['much_worse'],
  category: 'severe_worsening',
  reason: 'Reported that symptoms are much worse than yesterday.',
};

const QUESTIONS = [MOOD, SELF_HARM];
const RULES = [SELF_HARM_RULE, WORSENING_RULE];

describe('grading a day (FR-13.2 to FR-13.4)', () => {
  it('is green when nothing is wrong', () => {
    const outcome = evaluate(QUESTIONS, RULES, { mood: 'better', self_harm: 'no' });
    expect(outcome.status).toBe('green');
    expect(outcome.redFlags).toEqual([]);
  });

  it('is amber when an option says worsening', () => {
    const outcome = evaluate(QUESTIONS, RULES, { mood: 'worse', self_harm: 'no' });
    expect(outcome.status).toBe('amber');
    expect(outcome.amberFrom).toEqual(['mood']);
  });

  it('is red when a clinician-approved rule fires, and says why', () => {
    const outcome = evaluate(QUESTIONS, RULES, { mood: 'better', self_harm: 'yes' });
    expect(outcome.status).toBe('red');
    expect(outcome.redFlags).toEqual([
      {
        category: 'self_harm',
        questionId: 'self_harm',
        reason: 'Reported thoughts of self-harm on the daily check-in.',
      },
    ]);
  });

  /**
   * *** RED IS NEVER DILUTED. ***
   *
   * There is no arithmetic over severities, no scoring and no threshold. One
   * rule firing is a red day however green everything else was — a patient
   * reporting thoughts of self-harm alongside a better mood is not an amber,
   * and any design where good news could offset that is the wrong design.
   */
  it('stays red however much good news surrounds it', () => {
    const outcome = evaluate(QUESTIONS, RULES, { mood: 'better', self_harm: 'yes' });
    expect(outcome.status).toBe('red');
  });

  it('reports every rule that fired, not just the first', () => {
    const outcome = evaluate(QUESTIONS, RULES, { mood: 'much_worse', self_harm: 'yes' });
    expect(outcome.status).toBe('red');
    expect(outcome.redFlags.map((flag) => flag.category)).toEqual([
      'self_harm',
      'severe_worsening',
    ]);
  });

  it('names required questions that were skipped', () => {
    const outcome = evaluate(QUESTIONS, RULES, { mood: 'better' });
    expect(outcome.unanswered).toEqual(['self_harm']);
  });

  it('does not treat an empty string as an answer', () => {
    expect(evaluate(QUESTIONS, RULES, { mood: '  ', self_harm: 'no' }).unanswered).toEqual([
      'mood',
    ]);
  });

  /** A rule pointing at a question nobody answered simply does not fire. */
  it('ignores a rule whose question was not answered', () => {
    const outcome = evaluate([MOOD], [SELF_HARM_RULE], { mood: 'better' });
    expect(outcome.status).toBe('green');
  });

  it('matches a rule against any value of a multi-select answer', () => {
    const outcome = evaluate(QUESTIONS, RULES, { mood: 'better', self_harm: ['no', 'yes'] });
    expect(outcome.status).toBe('red');
  });
});

/**
 * *** FR-13.8. THE RULE THAT KEEPS THE SAFETY NET EVEN. ***
 *
 * "Doctor-added questions collect answers only. They carry no red-flag rules,
 * so safety alerting stays on the clinician-approved set."
 *
 * If a doctor's own question could grade a day, a red flag would mean something
 * different depending on who was treating the patient.
 */
describe('doctor-added questions (FR-13.8)', () => {
  const DOCTOR_QUESTION: CheckinQuestion = {
    id: 'mood',
    text: 'A question of my own that happens to reuse an approved id',
    type: 'single_choice',
    options: [{ value: 'worse', label: 'Worse', flag: 'amber' }],
  };

  /**
   * The nastiest case there is: a doctor adds a question whose id COLLIDES with
   * an approved one. Filtering by id means the approved question is dropped
   * from grading rather than the doctor's being graded — the safe direction, and
   * the reason this is done by construction rather than by a flag.
   */
  it('cannot grade a day, even when it collides with an approved question id', () => {
    const approved = withoutDoctorQuestions(QUESTIONS, [DOCTOR_QUESTION]);
    expect(approved.map((question) => question.id)).toEqual(['self_harm']);

    const outcome = evaluate(approved, [SELF_HARM_RULE], { mood: 'worse', self_harm: 'no' });
    expect(outcome.status).toBe('green');
    expect(outcome.amberFrom).toEqual([]);
  });

  it('is still shown to the patient, and marked as the doctor’s', () => {
    const shown = questionsFor(QUESTIONS, [
      { id: 'sleep_hours', text: 'How many hours did you sleep?', type: 'text' },
    ]);
    expect(shown.map((question) => [question.id, question.addedByDoctor])).toEqual([
      ['mood', false],
      ['self_harm', false],
      ['sleep_hours', true],
    ]);
  });
});

describe('the follow-up window', () => {
  const start = new Date('2026-09-15T00:00:00.000Z');

  it('counts the start day as day one', () => {
    expect(followupDay(start, new Date('2026-09-15T23:00:00.000Z'))).toBe(1);
    expect(followupDay(start, new Date('2026-09-21T06:00:00.000Z'))).toBe(7);
  });

  it('is negative before it starts and past the end after', () => {
    expect(followupDay(start, new Date('2026-09-14T00:00:00.000Z'))).toBe(0);
    expect(followupDay(start, new Date('2026-09-22T00:00:00.000Z'))).toBe(8);
  });

  /** Seven days INCLUSIVE of the first. Never a stored column. */
  it('ends on the seventh day, not the eighth', () => {
    expect(followupEndsOn(start, 7).toISOString().slice(0, 10)).toBe('2026-09-21');
  });
});

/**
 * The shipped pathways are placeholder CLINICAL content, so these check the
 * properties a clinician revising them must preserve — not the wording, which
 * is the client's to change.
 */
describe('the five shipped pathways (FR-13.1)', () => {
  it('are exactly the five the SRS names', () => {
    expect(DEFAULT_PATHWAYS.map((pathway) => pathway.code)).toEqual([
      'depression_anxiety',
      'sleep',
      'substance_use',
      'bipolar_psychosis',
      'general',
    ]);
  });

  it.each(DEFAULT_PATHWAYS)('$code parses as a valid pathway', (pathway) => {
    expect(questionsSchema.safeParse(pathway.questions).success).toBe(true);
    expect(redFlagRulesSchema.safeParse(pathway.redFlagRules).success).toBe(true);
  });

  /**
   * *** A RULE THAT NAMES A MISSING QUESTION CAN NEVER FIRE. ***
   * It is the worst failure available here: a safety rule that looks present in
   * the admin panel and is silently dead for every patient on the pathway.
   */
  it.each(DEFAULT_PATHWAYS)('every $code rule points at a question that exists', (pathway) => {
    const ids = new Set(pathway.questions.map((question) => question.id));
    const dangling = pathway.redFlagRules.filter((rule) => !ids.has(rule.questionId));
    expect(dangling).toEqual([]);
  });

  /**
   * The safety net must not be uneven. Whatever pathway a patient is on, the
   * two condition-independent findings are asked in the same words and carry
   * the same rules.
   */
  it.each(DEFAULT_PATHWAYS)('$code asks the shared safety questions', (pathway) => {
    const ids = pathway.questions.map((question) => question.id);
    expect(ids).toContain('self_harm');
    expect(ids).toContain('feeling_unsafe');
    const categories = pathway.redFlagRules.map((rule) => rule.category);
    expect(categories).toContain('self_harm');
    expect(categories).toContain('feeling_unsafe');
  });

  /** Between them the five must cover every finding FR-13.5 names. */
  it('cover all seven FR-13.5 red-flag categories', () => {
    const covered = new Set(
      DEFAULT_PATHWAYS.flatMap((pathway) => pathway.redFlagRules.map((rule) => rule.category)),
    );
    expect([...covered].sort()).toEqual([
      'confusion_or_agitation',
      'feeling_unsafe',
      'medication_side_effect',
      'self_harm',
      'severe_withdrawal',
      'severe_worsening',
      'violence_risk',
    ]);
  });

  /** A red status must always be explainable, so every rule carries its words. */
  it('give every rule a plain-words reason', () => {
    for (const pathway of DEFAULT_PATHWAYS) {
      for (const rule of pathway.redFlagRules) {
        expect(rule.reason.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('reading a stored pathway back', () => {
  /** jsonb is only as good as what wrote it; a broken set must grade nothing. */
  it('returns nothing rather than half a question set', () => {
    expect(parseQuestions('not an array')).toEqual([]);
    expect(parseQuestions([{ id: 'BAD ID', text: 'x', type: 'text' }])).toEqual([]);
    expect(parseRules([{ questionId: 'x' }])).toEqual([]);
  });

  it('round-trips a shipped pathway', () => {
    const [first] = DEFAULT_PATHWAYS;
    expect(parseQuestions(first.questions)).toHaveLength(first.questions.length);
    expect(parseRules(first.redFlagRules)).toHaveLength(first.redFlagRules.length);
  });
});

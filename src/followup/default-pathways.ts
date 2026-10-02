import { CheckinQuestion, RedFlagRule } from './pathway';

/**
 * *** PLACEHOLDER CLINICAL CONTENT. ***
 *
 * FR-13.1 names five pathways and FR-13.5 names seven red flags, so the shape
 * of these sets is specified. THE WORDING IS NOT. Question wording and
 * red-flag thresholds are clinical content requiring the client's clinician to
 * sign them off under SRS section 8 — exactly as the legal copy is, and seeded
 * the same way: these are what a brand new database starts with, and from the
 * first edit the admin panel owns them (FR-13.7).
 *
 * They are written to be safe rather than clever: every set asks the same
 * safety questions in the same words, so a red flag means the same thing
 * whichever pathway a patient is on, and only the pathway-specific questions
 * differ. A clinician revising these should keep that property.
 */

/**
 * The questions every pathway asks, in the same words.
 *
 * `feeling_unsafe` and `self_harm` are the two FR-13.5 findings that are not
 * specific to any condition, and asking them differently per pathway would make
 * the safety net uneven. `medication` is asked of everyone because FR-13.3
 * makes missed medicines an amber wherever they occur.
 */
const SAFETY_QUESTIONS: CheckinQuestion[] = [
  {
    id: 'self_harm',
    text: 'Have you had thoughts of harming yourself today?',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'no', label: 'No' },
      // Not flagged amber: it is picked up by a red-flag rule, and marking it
      // amber as well would double-count one answer.
      { value: 'fleeting', label: 'Briefly, but they passed' },
      { value: 'yes', label: 'Yes' },
    ],
  },
  {
    id: 'feeling_unsafe',
    text: 'Do you feel unsafe right now, for any reason?',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
  },
  {
    id: 'medication',
    text: 'Have you been able to take your medicines as prescribed?',
    type: 'single_choice',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'some', label: 'I missed some', flag: 'amber' },
      { value: 'no', label: 'No', flag: 'amber' },
      { value: 'not_prescribed', label: 'I was not prescribed any' },
    ],
  },
  {
    id: 'side_effects',
    text: 'Have you had any side effects from your medicines?',
    type: 'single_choice',
    options: [
      { value: 'none', label: 'None' },
      { value: 'mild', label: 'Mild', flag: 'amber' },
      { value: 'troubling', label: 'Troubling' },
    ],
  },
  {
    id: 'anything_else',
    text: 'Anything else you would like your provider to know?',
    type: 'text',
  },
];

/** The rules every pathway carries, worded identically for the same reason. */
const SAFETY_RULES: RedFlagRule[] = [
  {
    questionId: 'self_harm',
    whenAnswerIn: ['yes', 'fleeting'],
    category: 'self_harm',
    reason: 'Reported thoughts of self-harm on the daily check-in.',
  },
  {
    questionId: 'feeling_unsafe',
    whenAnswerIn: ['yes'],
    category: 'feeling_unsafe',
    reason: 'Reported feeling unsafe on the daily check-in.',
  },
  {
    questionId: 'side_effects',
    whenAnswerIn: ['troubling'],
    category: 'medication_side_effect',
    reason: 'Reported troubling side effects from prescribed medicines.',
  },
];

const worseBetter = (id: string, text: string): CheckinQuestion => ({
  id,
  text,
  type: 'single_choice',
  required: true,
  options: [
    { value: 'better', label: 'Better' },
    { value: 'same', label: 'About the same' },
    { value: 'worse', label: 'Worse', flag: 'amber' },
    // Amber as well as red-flagged: if a clinician later removes the rule, the
    // answer still raises the day rather than silently becoming green.
    { value: 'much_worse', label: 'Much worse', flag: 'amber' },
  ],
});

const SEVERE_WORSENING = (questionId: string): RedFlagRule => ({
  questionId,
  whenAnswerIn: ['much_worse'],
  category: 'severe_worsening',
  reason: 'Reported that symptoms are much worse than yesterday.',
});

export interface PathwayDefault {
  code: string;
  name: string;
  durationDays: number;
  questions: CheckinQuestion[];
  redFlagRules: RedFlagRule[];
}

/** FR-13.1's five, each with its own questions plus the shared safety set. */
export const DEFAULT_PATHWAYS: PathwayDefault[] = [
  {
    code: 'depression_anxiety',
    name: 'Depression and anxiety',
    durationDays: 7,
    questions: [
      worseBetter('mood', 'How has your mood been today, compared with yesterday?'),
      {
        id: 'anxiety',
        text: 'How anxious have you felt today?',
        type: 'single_choice',
        required: true,
        options: [
          { value: 'none', label: 'Not at all' },
          { value: 'mild', label: 'A little' },
          { value: 'moderate', label: 'Quite a lot', flag: 'amber' },
          { value: 'severe', label: 'Overwhelming', flag: 'amber' },
        ],
      },
      ...SAFETY_QUESTIONS,
    ],
    redFlagRules: [SEVERE_WORSENING('mood'), ...SAFETY_RULES],
  },
  {
    code: 'sleep',
    name: 'Sleep problems',
    durationDays: 7,
    questions: [
      worseBetter('sleep_quality', 'How did you sleep last night, compared with the night before?'),
      {
        id: 'hours_slept',
        text: 'Roughly how many hours did you sleep?',
        type: 'single_choice',
        options: [
          { value: 'under_3', label: 'Under 3', flag: 'amber' },
          { value: '3_to_5', label: '3 to 5', flag: 'amber' },
          { value: '5_to_7', label: '5 to 7' },
          { value: 'over_7', label: 'More than 7' },
        ],
      },
      ...SAFETY_QUESTIONS,
    ],
    redFlagRules: [SEVERE_WORSENING('sleep_quality'), ...SAFETY_RULES],
  },
  {
    code: 'substance_use',
    name: 'Substance use',
    durationDays: 7,
    questions: [
      {
        id: 'used_today',
        text: 'Have you used alcohol or any other substance today?',
        type: 'single_choice',
        required: true,
        options: [
          { value: 'no', label: 'No' },
          { value: 'less', label: 'Yes, less than usual', flag: 'amber' },
          { value: 'same_or_more', label: 'Yes, the same or more', flag: 'amber' },
        ],
      },
      {
        id: 'withdrawal',
        text: 'Have you had shaking, sweating, confusion or a seizure today?',
        type: 'single_choice',
        required: true,
        options: [
          { value: 'no', label: 'No' },
          { value: 'mild', label: 'Mild shaking or sweating', flag: 'amber' },
          { value: 'severe', label: 'Severe, or confusion or a seizure' },
        ],
      },
      ...SAFETY_QUESTIONS,
    ],
    redFlagRules: [
      {
        questionId: 'withdrawal',
        whenAnswerIn: ['severe'],
        category: 'severe_withdrawal',
        reason: 'Reported severe withdrawal symptoms, confusion or a seizure.',
      },
      ...SAFETY_RULES,
    ],
  },
  {
    code: 'bipolar_psychosis',
    name: 'Bipolar and psychosis',
    durationDays: 7,
    questions: [
      worseBetter('overall', 'How have you been today, compared with yesterday?'),
      {
        id: 'agitation',
        text: 'Have you felt confused, very agitated, or unable to sit still?',
        type: 'single_choice',
        required: true,
        options: [
          { value: 'no', label: 'No' },
          { value: 'mild', label: 'A little', flag: 'amber' },
          { value: 'severe', label: 'A great deal' },
        ],
      },
      {
        id: 'anger_towards_others',
        text: 'Have you felt you might harm someone else?',
        type: 'single_choice',
        required: true,
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ],
      },
      ...SAFETY_QUESTIONS,
    ],
    redFlagRules: [
      SEVERE_WORSENING('overall'),
      {
        questionId: 'agitation',
        whenAnswerIn: ['severe'],
        category: 'confusion_or_agitation',
        reason: 'Reported marked confusion or agitation.',
      },
      {
        questionId: 'anger_towards_others',
        whenAnswerIn: ['yes'],
        category: 'violence_risk',
        reason: 'Reported thoughts of harming someone else.',
      },
      ...SAFETY_RULES,
    ],
  },
  {
    code: 'general',
    name: 'General follow-up',
    durationDays: 7,
    questions: [
      worseBetter('overall', 'How have you been today, compared with yesterday?'),
      ...SAFETY_QUESTIONS,
    ],
    redFlagRules: [SEVERE_WORSENING('overall'), ...SAFETY_RULES],
  },
];

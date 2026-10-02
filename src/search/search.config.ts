import * as z from 'zod';

/**
 * M-09 owns NO table. Everything an admin can change here is an `app_config`
 * value (FR-5.7, FR-5.11), and the mapping itself is not even that - the
 * symptom-to-concern phrases are columns on `concerns`, owned by M-06.
 *
 * What is left for this module to own is the query side: what counts as a
 * crisis, what one word means in terms of another, what to suggest before the
 * patient has typed anything, and the wording the interface must show.
 */
export const CRISIS_KEYWORDS_KEY = 'search.crisis_keywords';
export const SYNONYMS_KEY = 'search.synonyms';
export const POPULAR_SEARCHES_KEY = 'search.popular_searches';
export const EMERGENCY_GUIDANCE_KEY = 'search.emergency_guidance';
export const DISCLAIMER_KEY = 'search.disclaimer';

/**
 * *** CLINICALLY APPROVED CONTENT, NOT A FINISHED LIST. ***
 *
 * SRS section 8 puts crisis wording and the symptom mapping among the content a
 * qualified clinician must review and approve before launch, and SRS 2.5 makes
 * providing it the client's responsibility. What ships is a starting point so
 * the guardrail is never absent - an empty list would mean a platform that
 * silently fails to notice self-harm language - and the client replaces it.
 *
 * Phrases, not stems. Matching is on whole tokens, so `die` never fires on
 * `diet`, and `end it all` needs those three words in that order.
 */
export const CRISIS_KEYWORDS: string[] = [
  // English
  'suicide',
  'suicidal',
  'kill myself',
  'killing myself',
  'end my life',
  'end it all',
  'want to die',
  'wanna die',
  'better off dead',
  'no reason to live',
  'not want to live',
  'self harm',
  'hurt myself',
  'cut myself',
  'cutting myself',
  'overdose',
  'take my own life',
  // Hindi in Latin script, which is how most patients type it
  'khudkushi',
  'atmahatya',
  'marna chahta hoon',
  'marna chahti hoon',
  'jaan dena',
  'jaan de dunga',
  'mar jaunga',
  'mar jaungi',
  'zinda nahi rehna',
  // Devanagari
  'आत्महत्या',
  'खुदकुशी',
  'मरना चाहता हूं',
  'मरना चाहती हूं',
  'जान देना',
];

/**
 * Query-side synonyms: one word or phrase in terms of another (FR-5.7).
 *
 * This is NOT the symptom-to-concern mapping - that is `concerns.match_phrases`
 * and belongs to M-06. This is the layer before it, so that a Hindi or informal
 * word reaches the mapping as the word the mapping was written in, and the
 * client does not have to repeat every colloquialism on every concern row.
 *
 * Both sides are matched, so adding `neend: sleep` makes a concern phrased in
 * either word reachable from either query.
 */
export const SYNONYMS: Record<string, string[]> = {
  // Hindi and Hinglish, the commonest way a query actually arrives
  neend: ['sleep'],
  नींद: ['sleep', 'neend'],
  ghabrahat: ['anxiety', 'panic'],
  घबराहट: ['anxiety', 'panic'],
  chinta: ['worry', 'anxiety'],
  चिंता: ['worry', 'anxiety'],
  udaas: ['sad', 'low mood'],
  उदास: ['sad', 'low mood'],
  dukhi: ['sad'],
  tanaav: ['stress'],
  tanav: ['stress'],
  तनाव: ['stress'],
  gussa: ['anger'],
  गुस्सा: ['anger'],
  dar: ['fear'],
  डर: ['fear'],
  nasha: ['addiction', 'substance use'],
  नशा: ['addiction', 'substance use'],
  sharab: ['alcohol'],
  शराब: ['alcohol'],
  bachcha: ['child'],
  bachche: ['child'],
  // Informal English
  cant: ['cannot', 'unable'],
  wont: ['will not'],
  insomnia: ['sleep'],
  panicky: ['panic'],
  stressed: ['stress'],
  worried: ['worry'],
  anxious: ['anxiety'],
  depressed: ['depression', 'low mood'],
  drinking: ['alcohol'],
  smoking: ['tobacco'],
};

/** What the search box offers before anything is typed (FR-5.11). */
export const POPULAR_SEARCHES: string[] = [
  'trouble sleeping',
  'feeling low',
  'constant worry',
  'panic attacks',
  'exam stress',
  'anger issues',
  'help with drinking',
  'child not talking',
];

/**
 * What a patient sees INSTEAD of results when crisis language is detected
 * (FR-5.6).
 *
 * *** THE CLIENT MUST CONFIRM EVERY NUMBER HERE BEFORE LAUNCH. *** These are
 * the national services current at the time of writing, and a helpline that has
 * changed number is worse than no helpline at all. SRS section 8 makes this
 * wording the client's to approve, which is why it is configuration and not a
 * constant in the build.
 */
export const EMERGENCY_GUIDANCE = {
  title: 'Help is available right now',
  message:
    'It sounds like you may be going through something very difficult. You do not have to face it alone, and you can talk to someone straight away. If you are in immediate danger, please call emergency services or go to your nearest hospital.',
  helplines: [
    { name: 'Tele-MANAS (national mental health helpline)', number: '14416', available: '24x7' },
    { name: 'KIRAN mental health helpline', number: '1800-599-0019', available: '24x7' },
    { name: 'Emergency services', number: '112', available: '24x7' },
  ],
  /** Shown under the helplines, so the screen is not a dead end. */
  footer:
    'You can also book a consultation, and our team will prioritise it. This app cannot provide emergency care.',
};

/**
 * FR-5.8 and SRS 2.4: the interface must state plainly that this recommends
 * whom to consult and does not screen, diagnose or make clinical decisions.
 *
 * It is returned with every search response rather than left to the app to
 * remember. A rule that only holds while a client renders it correctly is not
 * a rule the platform is keeping.
 */
export const DISCLAIMER =
  'This suggests which service may suit you. It does not screen, diagnose or decide treatment, and it is not a medical opinion.';

// -- Shapes, validated on the way out of `app_config` -------------------------

export const crisisKeywordsSchema = z.array(z.string().min(2).max(120)).max(1000);

export const synonymsSchema = z.record(
  z.string().min(1).max(80),
  z.array(z.string().min(1).max(80)).max(20),
);

export const popularSearchesSchema = z.array(z.string().min(1).max(120)).max(50);

export const emergencyGuidanceSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  helplines: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        number: z.string().min(3).max(40),
        available: z.string().max(80).optional(),
      }),
    )
    .min(1)
    .max(20),
  footer: z.string().max(500).optional(),
});

export const disclaimerSchema = z.string().min(1).max(600);

export type EmergencyGuidance = z.infer<typeof emergencyGuidanceSchema>;

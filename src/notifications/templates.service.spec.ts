import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { AuthenticatedActor } from '../common/auth';
import { NOTIFICATION_TEMPLATES, TEMPLATES_KEY } from './notification-templates';
import { NotificationTemplatesService, findForbiddenTerm } from './templates.service';

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'content' };

type Stored = Record<string, { title: string; body: string }>;

function build(over: { stored?: Stored; forbidden?: string[] } = {}) {
  const get = vi.fn<(key: string) => Promise<unknown>>().mockImplementation((key) => {
    if (key === TEMPLATES_KEY) return Promise.resolve(over.stored);
    return Promise.resolve(over.forbidden);
  });
  const set = vi.fn<(key: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const config = { get, set } as unknown as AppConfigService;
  return { service: new NotificationTemplatesService(config), set };
}

describe('NotificationTemplatesService', () => {
  let templates: ReturnType<typeof build>;

  beforeEach(() => {
    templates = build();
  });

  // -- The catalogue --------------------------------------------------------

  it('lists every template the platform can send, with what it may interpolate', async () => {
    const list = await templates.service.list();
    expect(list).toHaveLength(NOTIFICATION_TEMPLATES.length);
    expect(list.every((template) => template.isDefault)).toBe(true);
  });

  it('offers no clinical variable to any template', async () => {
    // Half of FR-16.2 is enforced by omission: copy cannot name a diagnosis if
    // there is no variable that could carry one into it.
    const list = await templates.service.list();
    const offered = new Set(list.flatMap((template) => template.placeholders));
    for (const clinical of ['diagnosis', 'riskLevel', 'concern', 'symptom', 'answers']) {
      expect(offered.has(clinical)).toBe(false);
    }
  });

  it('prefers the admin’s wording over the wording that shipped', async () => {
    const edited = build({
      stored: { booking_confirmed: { title: 'All set', body: 'See you at {{consultationTime}}.' } },
    });
    const template = await edited.service.get('booking_confirmed');
    expect(template.title).toBe('All set');
    expect(template.isDefault).toBe(false);
  });

  it('404s a code that does not exist', async () => {
    await expect(templates.service.get('not_a_template')).rejects.toMatchObject({
      status: 404,
      response: { code: 'TEMPLATE_NOT_FOUND' },
    });
  });

  // -- Rendering ------------------------------------------------------------

  it('fills a template in', async () => {
    const copy = await templates.service.render('booking_confirmed', {
      doctorName: 'Dr Rao',
      consultationTime: 'Monday at 3pm',
    });
    expect(copy.body).toBe('Your consultation with Dr Rao is confirmed for Monday at 3pm.');
  });

  it('refuses to render a message with a hole in it', async () => {
    // "Your consultation with  is confirmed for ." is worse than no message,
    // so a caller that forgot a variable gets a refusal rather than a send.
    await expect(
      templates.service.render('booking_confirmed', { doctorName: 'Dr Rao' }),
    ).rejects.toMatchObject({ response: { code: 'UNKNOWN_PLACEHOLDER' } });
  });

  it('renders a template that takes no variables', async () => {
    const copy = await templates.service.render('doctor_approved', {});
    expect(copy.body).toContain('verified');
  });

  // -- FR-16.2 --------------------------------------------------------------

  it('refuses copy that names a diagnosis', async () => {
    await expect(
      templates.service.update(
        'booking_confirmed',
        { title: 'Confirmed', body: 'Your depression consultation is confirmed.' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: 'CLINICAL_TERM_IN_COPY' } });
    expect(templates.set).not.toHaveBeenCalled();
  });

  it('refuses a diagnosis that arrives through a VARIABLE, not the copy', async () => {
    // The template is spotless; the service name is not. FR-16.2 is about what
    // the recipient reads, so the check runs on the rendered result too.
    await expect(
      templates.service.render('instant_request', { serviceName: 'Depression Care' }),
    ).rejects.toMatchObject({ response: { code: 'CLINICAL_TERM_IN_COPY' } });
  });

  it('ships no default copy that breaks its own rule', async () => {
    // The guard is worth nothing if the wording it ships with trips it.
    const terms = await templates.service.forbiddenTerms();
    for (const template of NOTIFICATION_TEMPLATES) {
      const found = findForbiddenTerm(`${template.title}\n${template.body}`, terms);
      expect(found, `${template.code} names "${found ?? ''}"`).toBeUndefined();
    }
  });

  it('matches whole words only', () => {
    // "OCD" inside an ordinary word is not a diagnosis, and a rule that fires
    // on innocent wording is one an operator learns to route around.
    expect(findForbiddenTerm('Please check the podcast', ['ocd'])).toBeUndefined();
    expect(findForbiddenTerm('Reviewed for OCD today', ['ocd'])).toBe('ocd');
    expect(findForbiddenTerm('ANXIETY is named here', ['anxiety'])).toBe('anxiety');
  });

  it('lets an admin add a term the platform did not ship with', async () => {
    // Which words count is a clinical-governance judgement, and it changes.
    const custom = build({ forbidden: ['burnout'] });
    await expect(
      custom.service.update(
        'booking_confirmed',
        { title: 'Confirmed', body: 'Your burnout session is confirmed.' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'CLINICAL_TERM_IN_COPY' } });
  });

  // -- Editing --------------------------------------------------------------

  it('saves wording that keeps to the rules', async () => {
    await templates.service.update(
      'booking_confirmed',
      { title: 'All set', body: 'Your consultation with {{doctorName}} is confirmed.' },
      ADMIN,
    );
    expect(templates.set.mock.calls[0][0]).toBe(TEMPLATES_KEY);
    expect((templates.set.mock.calls[0][1] as Stored).booking_confirmed.title).toBe('All set');
  });

  it('refuses a variable the template does not carry', async () => {
    // `booking_confirmed` has no patientName, so this would render literally.
    await expect(
      templates.service.update(
        'booking_confirmed',
        { title: 'Hi {{patientName}}', body: 'Confirmed.' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: 'UNKNOWN_PLACEHOLDER' } });
    expect(templates.set).not.toHaveBeenCalled();
  });

  it('keeps the other templates when one is edited', async () => {
    const edited = build({ stored: { consult_reminder: { title: 'Soon', body: 'Very soon.' } } });
    await edited.service.update('booking_confirmed', { title: 'A', body: 'B' }, ADMIN);
    expect((edited.set.mock.calls[0][1] as Stored).consult_reminder.title).toBe('Soon');
  });

  it('puts a template back to what shipped', async () => {
    const edited = build({ stored: { booking_confirmed: { title: 'Odd', body: 'Odder.' } } });
    await edited.service.resetToDefault('booking_confirmed', ADMIN);
    expect((edited.set.mock.calls[0][1] as Stored).booking_confirmed.title).toBe(
      'Your consultation is confirmed',
    );
  });
});

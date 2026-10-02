import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvironment, validateEnvironment } from '../../config/env.validation';
import { SlideOtpProvider } from './slide.provider';

const ENVIRONMENT = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  OTP_PROVIDER: 'slide',
  SLIDE_API_KEY: 'slide-test-key',
  SLIDE_WIDGET_ID: 'widget-test-id',
  SLIDE_BASE_URL: 'https://api.slide.test',
};

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

function respondWith(body: unknown, status = 200): FetchMock {
  const fn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  return fn.mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

/** The one request the adapter made, decoded. */
function sentTo(fetchMock: FetchMock) {
  const [url, init] = fetchMock.mock.calls[0];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

describe('SlideOtpProvider', () => {
  let provider: SlideOtpProvider;

  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({ ...ENVIRONMENT });
    provider = new SlideOtpProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -- Sending ---------------------------------------------------------------

  it("sends the widget and the number in Slide's own field names", async () => {
    const fetchMock = respondWith({ requestId: 'otpreq_123' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.request('+919876543210', 'patient_signin')).resolves.toEqual({
      challengeId: 'otpreq_123',
    });

    const sent = sentTo(fetchMock);
    expect(sent.url).toBe('https://api.slide.test/v1/otp/send');
    expect(sent.headers.authorization).toBe('Bearer slide-test-key');
    expect(sent.body).toEqual({ widgetId: 'widget-test-id', identifier: '+919876543210' });
  });

  it('*** does not send the purpose ***, because the widget owns the wording', async () => {
    const fetchMock = respondWith({ requestId: 'otpreq_123' });
    vi.stubGlobal('fetch', fetchMock);
    await provider.request('+919876543210', 'admin_2fa');

    expect(sentTo(fetchMock).body).not.toHaveProperty('template');
    expect(sentTo(fetchMock).body).not.toHaveProperty('purpose');
  });

  it('fails loudly when the send is accepted but no requestId comes back', async () => {
    vi.stubGlobal('fetch', respondWith({ status: 'queued' }));
    await expect(provider.request('+919876543210', 'patient_signin')).rejects.toMatchObject({
      response: { code: 'OTP_PROVIDER_UNAVAILABLE' },
    });
  });

  it('treats a refused send as an outage - the user typed only a number', async () => {
    vi.stubGlobal('fetch', respondWith({ error: 'unknown widget' }, 400));
    await expect(provider.request('+919876543210', 'patient_signin')).rejects.toMatchObject({
      status: 502,
      response: { code: 'OTP_PROVIDER_UNAVAILABLE' },
    });
  });

  // -- Verifying -------------------------------------------------------------

  it("sends the request id and the code in Slide's own field names", async () => {
    const fetchMock = respondWith({ accessToken: 'eyJ.token' });
    vi.stubGlobal('fetch', fetchMock);
    await provider.verify('otpreq_123', '424242');

    const sent = sentTo(fetchMock);
    expect(sent.url).toBe('https://api.slide.test/v1/otp/verify');
    expect(sent.body).toEqual({ requestId: 'otpreq_123', otp: '424242' });
  });

  it('treats a returned accessToken as the correct code', async () => {
    vi.stubGlobal('fetch', respondWith({ accessToken: 'eyJ.token' }));
    await expect(provider.verify('otpreq_123', '361355')).resolves.toBe(true);
  });

  it('treats a 200 with no token as a wrong code rather than a success', async () => {
    vi.stubGlobal('fetch', respondWith({ status: 'pending' }));
    await expect(provider.verify('otpreq_123', '999999')).resolves.toBe(false);
  });

  /**
   * *** THE FIX THIS FILE EXISTS FOR. ***
   *
   * Slide answers a wrong code with a 4xx. Turning that into a 502 would tell a
   * patient who mistyped a digit that the service is down, and would keep the
   * failed attempt out of `LoginRateLimitService` - which FR-1.9 obliges us to
   * count.
   */
  it.each([400, 404, 410, 422])('treats a %d as a wrong code, not an outage', async (status) => {
    vi.stubGlobal('fetch', respondWith({ error: 'invalid otp' }, status));
    await expect(provider.verify('otpreq_123', '999999')).resolves.toBe(false);
  });

  it.each([401, 403])('treats a %d as OUR key being wrong, not the user code', async (status) => {
    vi.stubGlobal('fetch', respondWith({ error: 'unauthorized' }, status));
    await expect(provider.verify('otpreq_123', '361355')).rejects.toMatchObject({
      status: 502,
      response: { code: 'OTP_PROVIDER_UNAVAILABLE' },
    });
  });

  it.each([429, 500, 503])('treats a %d as an outage', async (status) => {
    vi.stubGlobal('fetch', respondWith({ error: 'busy' }, status));
    await expect(provider.verify('otpreq_123', '361355')).rejects.toMatchObject({
      response: { code: 'OTP_PROVIDER_UNAVAILABLE' },
    });
  });

  // -- Transport -------------------------------------------------------------

  it('turns an unreachable provider into a 502, never a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<(url: string, init: RequestInit) => Promise<Response>>()
        .mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(provider.request('+919876543210', 'patient_signin')).rejects.toMatchObject({
      status: 502,
      response: { code: 'OTP_PROVIDER_UNAVAILABLE' },
    });
  });

  it('survives an error status whose body is not JSON', async () => {
    const fn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    fn.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);
    vi.stubGlobal('fetch', fn);

    await expect(provider.verify('otpreq_123', '361355')).rejects.toMatchObject({
      response: { code: 'OTP_PROVIDER_UNAVAILABLE' },
    });
  });

  it('gives up rather than hanging, so a stalled provider cannot pin a request open', async () => {
    const fetchMock = respondWith({ requestId: 'otpreq_1' });
    vi.stubGlobal('fetch', fetchMock);
    await provider.request('+919876543210', 'patient_signin');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

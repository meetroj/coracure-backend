import * as z from 'zod';

/**
 * Every environment variable the service reads, in one place. Boot fails with a
 * readable report if any of them is missing or malformed (SRS 6.1, 6.6).
 * Secrets live in the environment only, never in `app_config` and never in code.
 */
/** A zone Node's ICU actually knows. A typo here would silently shift every diary. */
function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The key in `livekit/livekit.yaml`, so every developer's container accepts
 * every developer's tokens. Refused in production below.
 */
const DEV_LIVEKIT_KEY = 'devkey';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    API_PREFIX: z.string().min(1).default('api'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** Behind a load balancer or ingress that terminates TLS. Required for a correct client IP. */
    TRUST_PROXY: z.stringbool().default(false),
    /** OpenAPI is served for the integrators; off by default outside development. */
    SWAGGER_ENABLED: z.stringbool().optional(),

    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// connection string'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
    /** How long a resolved `app_config` value is trusted before it is re-read. */
    APP_CONFIG_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),

    /**
     * Optional, and unused by this service today: nothing in `src` opens a
     * Redis connection. It was required at boot for a dependency that was never
     * built, which meant a deployment could not start without provisioning a
     * cache nothing would read.
     *
     * Kept in the schema rather than deleted because DEPLOYMENT.md's LiveKit
     * section needs one to coordinate a MULTI-NODE cluster, and because the
     * `app_config` cache is per-instance today (`APP_CONFIG_CACHE_TTL_MS`) - a
     * shared cache is the obvious later change. Make it required again on the
     * day something reads it.
     */
    REDIS_URL: z.url().optional(),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().min(1).default('15m'),
    JWT_REFRESH_TTL: z.string().min(1).default('30d'),
    /** How long an admin has to answer the two-factor challenge (M-02). */
    JWT_MFA_TTL: z.string().min(1).default('5m'),

    /**
     * OTP issue and verification (M-02). `slide` calls the provider; `stub`
     * accepts a fixed code so the flow can be driven without an account, and is
     * refused in production by the check below.
     */
    OTP_PROVIDER: z.enum(['slide', 'stub']).default('stub'),
    /**
     * Slide's real host, confirmed against its API reference and exercised
     * against the live service. The `/api` is part of the base: Slide publishes
     * `{base}/v1/otp/send`, and the deployed service serves it under `/api`.
     *
     * A DEFAULT THAT WORKS, not a placeholder. The previous default named a
     * host that does not resolve, which meant a deployment that set the key and
     * forgot the url booted perfectly happily and then failed on the first real
     * sign-in - no text message, and nothing in the boot log to say why.
     */
    SLIDE_BASE_URL: z.url().default('https://slide.synquic.com/api'),
    SLIDE_API_KEY: z.string().optional(),
    /**
     * The OTP widget the codes are sent from. Slide has no template field - the
     * widget owns the wording - so this is required for a send to happen at
     * all, and the refine below refuses a `slide` deployment without one.
     */
    SLIDE_WIDGET_ID: z.string().optional(),
    SLIDE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
    /** The code `stub` accepts. Never read when OTP_PROVIDER is `slide`. */
    OTP_STUB_CODE: z.string().min(4).default('000000'),

    /**
     * Object storage for uploaded documents (M-05 doctor credentials first).
     * `s3` signs real URLs; `stub` signs a URL that goes nowhere so the upload
     * and review flow can be driven locally, and is refused in production below.
     * Bytes never pass through this service: the client PUTs to the signed URL.
     */
    STORAGE_PROVIDER: z.enum(['s3', 'stub']).default('stub'),
    AWS_REGION: z.string().min(1).default('ap-south-1'),
    AWS_S3_BUCKET: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    /** How long an upload or download URL stays usable. Minutes, not hours. */
    STORAGE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    /**
     * The wall clock a provider's diary is written in (M-07). `doctor_availability`
     * stores a weekday and a local time, `consultations.scheduled_start_at` stores
     * an instant, and turning one into the other needs a zone. One deployment
     * serves one country, so it is one setting here rather than a column on every
     * provider - the same reasoning that keeps LiveKit to one `LIVEKIT_URL`.
     */
    /**
     * Payments (M-12). `razorpay` talks to the gateway; `stub` settles nothing
     * and signs its own webhooks with a local secret, so booking, billing,
     * refunds and payouts can all be driven before an account exists.
     *
     * Refused in production by the check below, like the OTP, storage and push
     * stubs - a platform that silently takes no money looks perfectly healthy.
     */
    PAYMENT_GATEWAY: z.enum(['razorpay', 'stub']).default('stub'),
    /** The PUBLIC key. Handed to the client to open checkout with. */
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    /**
     * Signs the webhooks. SEPARATE from the key secret in Razorpay's own model,
     * and the only thing standing between an open endpoint and anyone marking any
     * consultation paid (FR-7.6).
     */
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

    /**
     * The optional search assistant (M-09). `openai` is consulted ONLY when the
     * clinically approved mapping matched nothing, and only to pick from concerns
     * that already exist; `none` is a complete search on its own.
     *
     * Unlike the OTP, storage and push stubs, `none` is NOT refused in
     * production. Those three silently deliver nothing while looking healthy.
     * This one only declines to add suggestions to an answer the deterministic
     * engine has already given in full - which is a product decision, not a
     * misconfiguration.
     */
    SEARCH_AI_PROVIDER: z.enum(['openai', 'none']).default('none'),
    OPENAI_API_KEY: z.string().optional(),
    SEARCH_AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    /** A slow model must not hold a search request open; past this it is skipped. */
    SEARCH_AI_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(4000),

    /**
     * Push delivery (M-08). `fcm` sends through Firebase; `log` writes what it
     * would have sent and delivers nothing, so every flow that raises a
     * notification can be driven before any credentials exist. Refused in
     * production by the check below, exactly as the OTP and storage stubs are.
     *
     * There is no separate APNs setting. Firebase delivers to iOS THROUGH APNs
     * using the key uploaded in the Firebase console, so the APNs credential is
     * configured there and never reaches this service.
     */
    PUSH_PROVIDER: z.enum(['fcm', 'log']).default('log'),
    /**
     * A Firebase service account, per app. The patient and doctor apps are
     * SEPARATE store listings and therefore separate Firebase projects, so one
     * credential could not address both (MODULES M-08).
     *
     * Either the raw service-account JSON or the same JSON base64-encoded - the
     * second is what survives most secret managers and CI variables intact.
     */
    FCM_PATIENT_CREDENTIALS: z.string().optional(),
    FCM_DOCTOR_CREDENTIALS: z.string().optional(),
    /** How long a push send may take before it is treated as failed. */
    PUSH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(8000),

    /**
     * Video consultation (M-14). LiveKit is SELF-HOSTED - a separate server
     * process that carries the WebRTC media, never this one. This service is the
     * control plane only: it authenticates, authorises, and mints join tokens.
     *
     * ONE deployment, so ONE url. That is why `consultations` carries no
     * `livekit_server_url` - there is nothing to vary per row.
     *
     * There is no `stub` provider here, unlike OTP, storage, push and payments.
     * Those four stand in for a remote account that does not exist yet; LiveKit
     * is a container in this repo's compose file, so the local provider IS the
     * real one and the same code path runs against it (LiveKit_strategy 32).
     */
    LIVEKIT_URL: z
      .string()
      .regex(/^wss?:\/\/.+/, 'must be a ws:// or wss:// LiveKit URL')
      .default('ws://localhost:7880'),
    LIVEKIT_API_KEY: z.string().optional(),
    /**
     * *** NEVER LEAVES THIS SERVICE. *** It is the whole of a room's access
     * control - anyone holding it can mint a token for any room, as any identity.
     * It also signs the webhooks in the other direction: LiveKit reuses this same
     * pair rather than issuing a separate webhook secret the way Razorpay does,
     * so there is no third variable here.
     */
    LIVEKIT_API_SECRET: z.string().optional(),
    /**
     * How long a join token stays valid. MINUTES, deliberately. The token is not
     * stored anywhere, so a leaked one cannot be revoked - it can only be allowed
     * to expire. Long enough to survive a slow app start and one retry.
     *
     * This bounds the JOIN, not the call: LiveKit checks the token when the
     * client connects, and a participant already in the room stays in it.
     */
    LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),

    PLATFORM_TIMEZONE: z
      .string()
      .min(1)
      .default('Asia/Kolkata')
      .refine(isTimeZone, { error: 'must be an IANA time zone name, e.g. Asia/Kolkata' }),
  })
  .refine((config) => config.OTP_PROVIDER !== 'slide' || Boolean(config.SLIDE_API_KEY), {
    path: ['SLIDE_API_KEY'],
    error: 'is required when OTP_PROVIDER is "slide"',
  })
  /**
   * Slide sends from a widget, so a key without one cannot deliver a single
   * code. Checked at boot rather than discovered on a patient's first sign-in.
   */
  .refine((config) => config.OTP_PROVIDER !== 'slide' || Boolean(config.SLIDE_WIDGET_ID), {
    path: ['SLIDE_WIDGET_ID'],
    error: 'is required when OTP_PROVIDER is "slide" - Slide sends codes from a widget',
  })
  .refine((config) => config.NODE_ENV !== 'production' || config.OTP_PROVIDER === 'slide', {
    path: ['OTP_PROVIDER'],
    error: 'must be "slide" in production - the stub accepts a fixed code',
  })
  .refine((config) => config.STORAGE_PROVIDER !== 's3' || Boolean(config.AWS_S3_BUCKET), {
    path: ['AWS_S3_BUCKET'],
    error: 'is required when STORAGE_PROVIDER is "s3"',
  })
  .refine((config) => config.NODE_ENV !== 'production' || config.STORAGE_PROVIDER === 's3', {
    path: ['STORAGE_PROVIDER'],
    error: 'must be "s3" in production - the stub stores nothing',
  })
  .refine((config) => config.PUSH_PROVIDER !== 'fcm' || Boolean(config.FCM_PATIENT_CREDENTIALS), {
    path: ['FCM_PATIENT_CREDENTIALS'],
    error: 'is required when PUSH_PROVIDER is "fcm"',
  })
  .refine((config) => config.PUSH_PROVIDER !== 'fcm' || Boolean(config.FCM_DOCTOR_CREDENTIALS), {
    path: ['FCM_DOCTOR_CREDENTIALS'],
    error: 'is required when PUSH_PROVIDER is "fcm"',
  })
  .refine((config) => config.NODE_ENV !== 'production' || config.PUSH_PROVIDER === 'fcm', {
    path: ['PUSH_PROVIDER'],
    error: 'must be "fcm" in production - the log provider delivers nothing',
  })
  .refine((config) => config.SEARCH_AI_PROVIDER !== 'openai' || Boolean(config.OPENAI_API_KEY), {
    path: ['OPENAI_API_KEY'],
    error: 'is required when SEARCH_AI_PROVIDER is "openai"',
  })
  .refine(
    (config) =>
      config.PAYMENT_GATEWAY !== 'razorpay' ||
      Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET),
    {
      path: ['RAZORPAY_KEY_ID'],
      error: 'and RAZORPAY_KEY_SECRET are required when PAYMENT_GATEWAY is "razorpay"',
    },
  )
  .refine(
    (config) => config.PAYMENT_GATEWAY !== 'razorpay' || Boolean(config.RAZORPAY_WEBHOOK_SECRET),
    {
      path: ['RAZORPAY_WEBHOOK_SECRET'],
      error:
        'is required when PAYMENT_GATEWAY is "razorpay" - without it any caller could mark a consultation paid',
    },
  )
  .refine((config) => config.NODE_ENV !== 'production' || config.PAYMENT_GATEWAY === 'razorpay', {
    path: ['PAYMENT_GATEWAY'],
    error: 'must be "razorpay" in production - the stub settles nothing',
  })
  /**
   * M-14. The credentials are optional so that the modules before this one can
   * be developed without a LiveKit container running - but the moment either is
   * set, BOTH must be, because a key without its secret signs nothing and a
   * secret without its key verifies nothing.
   */
  .refine((config) => Boolean(config.LIVEKIT_API_KEY) === Boolean(config.LIVEKIT_API_SECRET), {
    path: ['LIVEKIT_API_KEY'],
    error:
      'and LIVEKIT_API_SECRET must be set together - one without the other cannot sign or verify anything',
  })
  .refine((config) => config.NODE_ENV !== 'production' || Boolean(config.LIVEKIT_API_SECRET), {
    path: ['LIVEKIT_API_SECRET'],
    error:
      'is required in production - without it no consultation can be joined and no session is recorded',
  })
  /**
   * SRS 6.2 and LiveKit_strategy 19: the production client endpoint is `wss`.
   * A `ws` endpoint would carry the join token - a bearer credential for the
   * room - in clear text, and browsers refuse an insecure socket from an
   * https page anyway, so this fails at boot rather than at the first call.
   */
  /**
   * LiveKit_strategy 31: development credentials are never reused in
   * production. `devkey` is the pair committed to `livekit/livekit.yaml` so the
   * local container works out of the box, which means it is public - and a
   * public key is not a key.
   */
  .refine(
    (config) => config.NODE_ENV !== 'production' || config.LIVEKIT_API_KEY !== DEV_LIVEKIT_KEY,
    {
      path: ['LIVEKIT_API_KEY'],
      error: 'is the committed development key - production needs its own pair',
    },
  )
  .refine((config) => config.NODE_ENV !== 'production' || config.LIVEKIT_URL.startsWith('wss://'), {
    path: ['LIVEKIT_URL'],
    error: 'must be wss:// in production - a ws:// endpoint sends the join token in clear text',
  });

export type Environment = z.infer<typeof environmentSchema>;

let resolved: Environment | undefined;

/** ConfigModule validator. Keeps unlisted variables so later modules can read their own. */
export function validateEnvironment(raw: Record<string, unknown>): Record<string, unknown> {
  const result = environmentSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment configuration\n${z.prettifyError(result.error)}`);
  }
  resolved = result.data;
  return { ...raw, ...result.data };
}

/**
 * Typed environment access. Used instead of string keys on ConfigService, and
 * available before the Nest container exists (adapter and logger options).
 */
export function env(): Environment {
  if (!resolved) validateEnvironment(process.env);
  return resolved as Environment;
}

/** Test seam: forget the parsed environment so the next `env()` re-reads it. */
export function resetEnvironment(): void {
  resolved = undefined;
}

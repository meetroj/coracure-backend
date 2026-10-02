import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { Messaging, getMessaging } from 'firebase-admin/messaging';

import { env } from '../../config/env.validation';
import { PushAudience, PushMessage, PushProvider, PushResult } from './push.provider';

/**
 * Firebase Cloud Messaging, one client per app.
 *
 * The patient and doctor apps are separate store listings, so they are separate
 * Firebase projects with separate service accounts, and a single client could
 * not address both. `firebase-admin` supports that through NAMED apps, which is
 * why each one is initialised under its audience rather than as the default.
 *
 * iOS is reached through this same client: Firebase forwards to APNs using the
 * key uploaded in the Firebase console. There is nothing APNs-specific here.
 *
 * Clients are built lazily and then held. Initialising at construction would
 * make a malformed credential a boot failure for the whole service, and a
 * platform that cannot send a reminder should still be able to take a booking.
 */
@Injectable()
export class FirebasePushProvider implements PushProvider, OnModuleDestroy {
  private readonly logger = new Logger(FirebasePushProvider.name);
  private readonly apps = new Map<PushAudience, App | null>();

  async send(message: PushMessage): Promise<PushResult> {
    const messaging = this.messagingFor(message.audience);
    if (!messaging) {
      return { delivered: false, reason: 'push credentials unavailable', tokenIsDead: false };
    }

    try {
      await withTimeout(
        messaging.send({
          token: message.token,
          notification: { title: message.title, body: message.body },
          data: message.data,
          // Alerts a provider must act on are worth waking the device for; the
          // rest can wait for the next time it is awake, which is what keeps a
          // reminder from costing a patient their battery overnight.
          android: { priority: 'high' },
          apns: { payload: { aps: { sound: 'default' } } },
        }),
        env().PUSH_TIMEOUT_MS,
      );
      return { delivered: true };
    } catch (error) {
      const code = errorCode(error);
      return {
        delivered: false,
        reason: code,
        // The two codes that mean the token itself is finished, rather than the
        // send having gone wrong. Anything else may succeed on a retry.
        tokenIsDead:
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token',
      };
    }
  }

  onModuleDestroy(): Promise<unknown> {
    const open = [...this.apps.values()].filter((app): app is App => app !== null);
    this.apps.clear();
    return Promise.all(open.map((app) => deleteApp(app)));
  }

  private messagingFor(audience: PushAudience): Messaging | null {
    if (!this.apps.has(audience)) this.apps.set(audience, this.initialise(audience));
    const app = this.apps.get(audience);
    return app ? getMessaging(app) : null;
  }

  private initialise(audience: PushAudience): App | null {
    const raw =
      audience === 'patient' ? env().FCM_PATIENT_CREDENTIALS : env().FCM_DOCTOR_CREDENTIALS;
    if (!raw) {
      // Unreachable in production - `env.validation` demands both when
      // PUSH_PROVIDER is `fcm` - but reachable if someone selects `fcm` locally
      // with one app configured, and a missing reminder beats a crash loop.
      this.logger.error({ audience }, 'No Firebase credentials for this app');
      return null;
    }

    try {
      const credentials = parseServiceAccount(raw);
      return initializeApp({ credential: cert(credentials) }, `coracure-${audience}`);
    } catch (error) {
      this.logger.error({ audience, err: error }, 'Firebase credentials could not be read');
      return null;
    }
  }
}

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/**
 * Reads a service account from the environment, as raw JSON or as base64 of the
 * same JSON. Both are accepted because the raw form is what Google hands you and
 * the encoded form is what survives most secret managers and CI variables with
 * its newlines intact - and a private key that lost its newlines fails at the
 * first send with an error that names none of this.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;

  const projectId = parsed.project_id ?? parsed.projectId;
  const clientEmail = parsed.client_email ?? parsed.clientEmail;
  const privateKey = parsed.private_key ?? parsed.privateKey;
  if (
    typeof projectId !== 'string' ||
    typeof clientEmail !== 'string' ||
    typeof privateKey !== 'string'
  ) {
    throw new Error('service account is missing project_id, client_email or private_key');
  }

  return {
    projectId,
    clientEmail,
    // A key pasted through a shell or a JSON string often arrives with its
    // newlines escaped. Left that way, signing fails for a reason that reads
    // like a permissions problem.
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code).slice(0, 200);
  }
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown push failure';
}

/** Firebase has its own retries; without a ceiling one send can outlive the request. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('push timed out')), ms).unref(),
    ),
  ]);
}

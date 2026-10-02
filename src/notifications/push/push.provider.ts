/**
 * The push port.
 *
 * "Other modules raise notifications without knowing the delivery channel"
 * (MODULES M-08, done-when). This is the seam that makes that true: everything
 * above it deals in a recipient and a template, and only what is below knows
 * that delivery is Firebase at all.
 *
 * There is no separate APNs implementation, and that is not an omission.
 * Firebase delivers to iOS THROUGH APNs, using the key uploaded in the Firebase
 * console, so an APNs credential is configured there and never reaches this
 * service. A second client here would be a second thing to keep in step for no
 * behaviour that Firebase does not already give.
 */
export const PUSH_PROVIDER = Symbol('PushProvider');

/**
 * Which app to deliver through. The patient and doctor apps are separate store
 * listings and therefore separate Firebase projects with separate credentials,
 * so this is not cosmetic - the wrong one simply cannot address the device.
 *
 * There is no `admin`: an admin has no push token and reads the panel.
 */
export type PushAudience = 'patient' | 'doctor';

export interface PushMessage {
  audience: PushAudience;
  /** The device token from the recipient's account row. */
  token: string;
  title: string;
  body: string;
  /** Deep-link payload. Values are strings - FCM data payloads carry nothing else. */
  data?: Record<string, string>;
}

export type PushResult =
  | { delivered: true }
  /**
   * `tokenIsDead` means the device has uninstalled or the token was replaced.
   * It is the one failure worth acting on: the token is cleared from the
   * account row so the platform stops pushing into the void, and so a handset
   * that changed hands does not keep receiving somebody else's alerts.
   */
  | { delivered: false; reason: string; tokenIsDead: boolean };

export interface PushProvider {
  /**
   * Attempts one delivery. NEVER throws: a push that cannot be sent is a
   * `delivered: false` with a reason, because the in-app notification has
   * already been written and the caller's own work must not fail over it.
   */
  send(message: PushMessage): Promise<PushResult>;
}

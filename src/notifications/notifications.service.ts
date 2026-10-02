import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AccountStatus, Notification, NotificationStatus, Prisma } from '@prisma/client';

import { AdminPermissionLevel, AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationCode, RecipientKind, templateDefinition } from './notification-templates';
import { NotificationsError } from './notifications.errors';
import { PUSH_PROVIDER, PushAudience, PushProvider } from './push/push.provider';
import { NotificationTemplatesService } from './templates.service';

/** Exactly one of these. The same rule the table enforces with a CHECK. */
export type Recipient = { patientId: string } | { doctorId: string } | { adminId: string };

export interface NotifyInput {
  code: NotificationCode;
  to: Recipient;
  /** Values for the template's placeholders. Never free-form copy. */
  variables?: Record<string, string>;
  /** Ties the notification to one consultation for the audit trail (SRS 6.7). */
  consultationId?: string;
  /** Where tapping it should land in the app. */
  deepLink?: Record<string, string>;
}

/** What a recipient reads. `id` is a string: the column is a bigint. */
export interface NotificationRecord {
  id: string;
  templateCode: string;
  title: string;
  body: string;
  deepLinkData: unknown;
  consultationId: string | null;
  status: NotificationStatus;
  createdAt: Date;
  readAt: Date | null;
}

export interface InboxQuery {
  unreadOnly?: boolean;
  limit?: number;
  before?: Date;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * M-08's public interface, and the only part of it other modules touch.
 *
 * *** `notify` NEVER THROWS. *** A booking is not undone because a reminder
 * could not be worded, and a safety alert that fails to push must not roll back
 * the check-in that raised it. Every failure here ends up in the row's
 * `status` and `failure_reason`, or in the error log, and the caller carries on.
 *
 * The caller also never learns how delivery happens. It names a template and a
 * recipient; whether that becomes a Firebase message, a row an admin reads in
 * the panel, or nothing at all because the device has no token, is settled
 * below this line - which is the whole of the module's done-when.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: NotificationTemplatesService,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
  ) {}

  // -- Raising --------------------------------------------------------------

  /**
   * Writes the notification and tries to deliver it. Returns the row, or null
   * if it was refused before anything was written.
   *
   * A refusal is deliberate rather than a swallowed error: copy with a hole in
   * it, or copy that names a diagnosis, is not something to deliver anyway. The
   * row is not created at all, because a notification nobody may read is not a
   * notification - it is a log line, and that is where it goes.
   */
  async notify(input: NotifyInput): Promise<NotificationRecord | null> {
    const kind = recipientKind(input.to);
    try {
      this.assertAudience(input.code, kind);
      const copy = await this.templates.render(input.code, input.variables ?? {});

      const created = await this.prisma.notification.create({
        data: {
          ...recipientColumn(input.to),
          templateCode: input.code,
          title: copy.title,
          body: copy.body,
          deepLinkData: input.deepLink,
          consultationId: input.consultationId ?? null,
        },
      });

      return shape(await this.deliver(created, kind));
    } catch (error) {
      this.logger.error(
        { code: input.code, recipient: kind, err: error },
        'Notification was not raised',
      );
      return null;
    }
  }

  /**
   * Raises the same notification for every admin at a permission level.
   *
   * "Admin notifications target the responsible admin account" (MODULES M-08).
   * The responsible account is the one holding the level that owns the queue -
   * `care_coordinator` for safety and follow-up alerts - so callers name a
   * level and this resolves the people. Addressing a named admin instead would
   * mean an alert going quiet the day they leave.
   */
  async notifyAdmins(
    level: AdminPermissionLevel | AdminPermissionLevel[],
    input: Omit<NotifyInput, 'to'>,
  ): Promise<number> {
    // *** SUPER ADMINS ARE INCLUDED IN EVERY LEVEL. ***
    //
    // `assertPermission` already treats `super_admin` as passing everything -
    // "a level that cannot reach a section is a level that cannot fix it" - and
    // an exact-match filter here contradicted that: a super admin could open
    // the safety queue and was never told there was anything in it.
    //
    // It bites hardest on a NEW deployment, where super admin is the only level
    // that exists yet. M-16's red-flag alerts went to the treating doctor and
    // to nobody else, silently, which is the worst way for a safety feature to
    // fail. Found by raising a real alert against a fresh database.
    // SEVERAL levels in ONE call, deliberately. An alert addressed to both the
    // care coordinators and clinical governance is ONE alert: calling this
    // twice would send a super admin - who is in both - the same notification
    // twice, and a queue that repeats itself is a queue people stop reading.
    const asked = Array.isArray(level) ? level : [level];
    const levels: AdminPermissionLevel[] = [...new Set([...asked, 'super_admin' as const])];

    const admins = await this.prisma.admin.findMany({
      where: { permissionLevel: { in: levels }, status: AccountStatus.active },
      select: { id: true },
    });
    const raised = await Promise.all(
      admins.map((admin) => this.notify({ ...input, to: { adminId: admin.id } })),
    );
    return raised.filter(Boolean).length;
  }

  // -- Reading --------------------------------------------------------------

  /** The in-app inbox. Failed rows are excluded: they are for an operator, not a reader. */
  async inboxFor(actor: AuthenticatedActor, query: InboxQuery = {}): Promise<NotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        ...ownerFilter(actor),
        status: { not: NotificationStatus.failed },
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(query.before ? { createdAt: { lt: query.before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    });
    return rows.map(shape);
  }

  /** The badge count. */
  async unreadCountFor(actor: AuthenticatedActor): Promise<{ unread: number }> {
    const unread = await this.prisma.notification.count({
      where: { ...ownerFilter(actor), status: { not: NotificationStatus.failed }, readAt: null },
    });
    return { unread };
  }

  /**
   * Marks one as read. Scoped to the caller's own rows, so an id belonging to
   * somebody else reads as absent rather than as a refusal that confirms it
   * exists - the same shape M-07 uses for another provider's diary.
   */
  async markRead(actor: AuthenticatedActor, notificationId: string): Promise<void> {
    const id = asBigInt(notificationId);
    const updated = await this.prisma.notification.updateMany({
      where: { id, ...ownerFilter(actor), readAt: null },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) await this.assertExistsForActor(actor, id);
  }

  /** Clears the badge in one call, rather than one request per row. */
  async markAllRead(actor: AuthenticatedActor): Promise<{ marked: number }> {
    const updated = await this.prisma.notification.updateMany({
      where: { ...ownerFilter(actor), status: { not: NotificationStatus.failed }, readAt: null },
      data: { readAt: new Date() },
    });
    return { marked: updated.count };
  }

  // -- Delivery -------------------------------------------------------------

  /**
   * Resolves the recipient's device and pushes, then records what happened.
   *
   * The three outcomes, and why each is what it is:
   *
   *   - **an admin** has no push token by design (SRS 2.3 puts the panel in a
   *     desktop browser). The row IS the delivery, so it goes straight to
   *     `sent`. Leaving it `queued` would build a backlog that nothing drains.
   *   - **no device token** - never signed in on a handset, or signed out,
   *     which clears it (FR-1.8). Also `sent`: the in-app inbox has it, and
   *     `failed` would claim it never reached them when the app will show it.
   *   - **push rejected** - `failed`, with the reason. The row still stands and
   *     the recipient still sees it in the app, which is exactly why a failed
   *     push is a delivery problem to watch rather than a lost notification.
   */
  private async deliver(row: Notification, kind: RecipientKind): Promise<Notification> {
    if (kind === 'admin') return this.settle(row, { delivered: true });

    const audience: PushAudience = kind;
    const token = await this.deviceTokenFor(row, kind);
    if (!token) return this.settle(row, { delivered: true });

    const result = await this.push.send({
      audience,
      token,
      title: row.title,
      body: row.body,
      data: {
        templateCode: row.templateCode,
        notificationId: row.id.toString(),
        ...(row.consultationId ? { consultationId: row.consultationId } : {}),
        ...deepLinkStrings(row.deepLinkData),
      },
    });

    if (!result.delivered && result.tokenIsDead) await this.clearDeviceToken(row, kind);
    return this.settle(row, result);
  }

  private settle(
    row: Notification,
    result: { delivered: true } | { delivered: false; reason: string },
  ): Promise<Notification> {
    // The CHECK constraints pair these: `sent` has a time, `failed` has a
    // reason. Writing them together is what keeps that true from up here.
    return this.prisma.notification.update({
      where: { id: row.id },
      data: result.delivered
        ? { status: NotificationStatus.sent, sentAt: new Date(), failureReason: null }
        : {
            status: NotificationStatus.failed,
            sentAt: null,
            failureReason: result.reason.slice(0, 200),
          },
    });
  }

  /**
   * The current token on the account row, read at send time.
   *
   * Never cached and never copied onto the notification: a device that signed
   * out has had its token cleared, and a stale copy here would push somebody
   * else's alert to whoever now holds the handset (FR-1.8).
   */
  private async deviceTokenFor(row: Notification, kind: RecipientKind): Promise<string | null> {
    if (kind === 'patient' && row.patientId) {
      const patient = await this.prisma.patient.findUnique({
        where: { id: row.patientId },
        select: { pushToken: true },
      });
      return patient?.pushToken ?? null;
    }
    if (kind === 'doctor' && row.doctorId) {
      const doctor = await this.prisma.doctor.findUnique({
        where: { id: row.doctorId },
        select: { pushToken: true },
      });
      return doctor?.pushToken ?? null;
    }
    return null;
  }

  /** A token Firebase has retired is cleared, so the platform stops pushing into the void. */
  private async clearDeviceToken(row: Notification, kind: RecipientKind): Promise<void> {
    try {
      if (kind === 'patient' && row.patientId) {
        await this.prisma.patient.update({
          where: { id: row.patientId },
          data: { pushToken: null },
        });
      } else if (kind === 'doctor' && row.doctorId) {
        await this.prisma.doctor.update({ where: { id: row.doctorId }, data: { pushToken: null } });
      }
    } catch (error) {
      // Tidying up must not turn a failed push into a failed request.
      this.logger.warn({ err: error }, 'Could not clear a dead push token');
    }
  }

  // -- Internals ------------------------------------------------------------

  /**
   * A code may only reach the audience its template declares. Without this,
   * `pending_documentation` addressed to a patient would render happily and
   * tell them their provider is behind on paperwork.
   */
  private assertAudience(code: NotificationCode, kind: RecipientKind): void {
    const definition = templateDefinition(code);
    if (!definition) {
      throw new AppException(
        NotificationsError.TEMPLATE_NOT_FOUND,
        `There is no notification template "${code}".`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (!definition.audience.includes(kind)) {
      throw new AppException(
        NotificationsError.TEMPLATE_NOT_FOUND,
        `"${code}" is not addressed to a ${kind}. It is for: ${definition.audience.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertExistsForActor(actor: AuthenticatedActor, id: bigint): Promise<void> {
    const exists = await this.prisma.notification.count({ where: { id, ...ownerFilter(actor) } });
    if (exists === 0) {
      throw new AppException(
        NotificationsError.NOTIFICATION_NOT_FOUND,
        'That notification does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    // It exists and is already read. Marking it again is not a failure.
  }
}

/** The caller's own rows, by the column that matches their account kind. */
function ownerFilter(actor: AuthenticatedActor): Prisma.NotificationWhereInput {
  if (actor.type === 'patient') return { patientId: actor.id };
  if (actor.type === 'doctor') return { doctorId: actor.id };
  return { adminId: actor.id };
}

function recipientKind(to: Recipient): RecipientKind {
  if ('patientId' in to) return 'patient';
  if ('doctorId' in to) return 'doctor';
  return 'admin';
}

function recipientColumn(to: Recipient): Prisma.NotificationUncheckedCreateInput {
  if ('patientId' in to)
    return { patientId: to.patientId } as Prisma.NotificationUncheckedCreateInput;
  if ('doctorId' in to) return { doctorId: to.doctorId } as Prisma.NotificationUncheckedCreateInput;
  return { adminId: to.adminId } as Prisma.NotificationUncheckedCreateInput;
}

/** FCM data payloads carry strings and nothing else. */
function deepLinkStrings(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== 'object') out[key] = String(item);
  }
  return out;
}

/** The id is a bigint; a client that sends anything else gets a 404, not a 500. */
function asBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new AppException(
      NotificationsError.NOTIFICATION_NOT_FOUND,
      'That notification does not exist.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/** `id` becomes a string on the way out: JSON has no bigint. */
function shape(row: Notification): NotificationRecord {
  return {
    id: row.id.toString(),
    templateCode: row.templateCode,
    title: row.title,
    body: row.body,
    deepLinkData: row.deepLinkData,
    consultationId: row.consultationId,
    status: row.status,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

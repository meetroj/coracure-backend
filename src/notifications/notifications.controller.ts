import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { InboxQueryDto, UpdateTemplateDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';
import { NotificationTemplatesService } from './templates.service';

/**
 * The in-app inbox (FR-16.1).
 *
 * Push and in-app are not two systems: the row IS the in-app notification, and
 * a push is an attempt to put the same copy on a lock screen. That is why these
 * routes work identically whether or not push credentials exist, and why a
 * patient who has never allowed notifications still has a complete inbox.
 *
 * One controller for patients, providers and admins. The account kind decides
 * which column is filtered on, so nobody can ask for anyone else's rows - and
 * an admin reads theirs here rather than being pushed anything (SRS 2.3).
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Roles('patient', 'doctor', 'admin')
@Controller({ path: 'me/notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'My notifications, newest first',
    description:
      'Deliveries that failed are not listed: a push that did not land is an operations problem, and the copy is here in the app either way.',
  })
  inbox(@Query() query: InboxQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.notifications.inboxFor(actor, {
      unreadOnly: query.unreadOnly,
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'The badge count' })
  unreadCount(@CurrentActor() actor: AuthenticatedActor) {
    return this.notifications.unreadCountFor(actor);
  }

  @Post(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark one as read',
    description: 'Reading is `readAt`, not a status. Marking an already-read one again is fine.',
  })
  markRead(
    @Param('notificationId') notificationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.notifications.markRead(actor, notificationId);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Clear the badge in one call' })
  markAllRead(@CurrentActor() actor: AuthenticatedActor) {
    return this.notifications.markAllRead(actor);
  }
}

/**
 * Notification copy, edited from the panel (FR-16.3).
 *
 * `content` runs the wording, as it does the catalogue in M-06.
 * `clinical_governance` is here too, because FR-16.2 - never naming a diagnosis
 * - is a clinical judgement about wording rather than a marketing one, and the
 * level that owns that rule should be able to fix a breach of it directly.
 */
@ApiTags('admin/notifications')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/notification-templates', version: '1' })
export class AdminNotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplatesService) {}

  @Get()
  @ApiOperation({
    summary: 'Every notification the platform sends, with its current wording',
    description:
      '`placeholders` is the complete list this template may use - there is deliberately no clinical variable among them. `isDefault` is false once it has been edited.',
  })
  list(@CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.templates.list();
  }

  @Get(':code')
  @ApiOperation({ summary: 'One template' })
  get(@Param('code') code: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.templates.get(code);
  }

  @Patch(':code')
  @ApiOperation({
    summary: 'Reword a notification (FR-16.3)',
    description:
      'Live within the config cache window, with no app release. Refused if the copy names a diagnosis (FR-16.2) or uses a variable this template does not carry — both before anything is saved, so the previous wording stays live.',
  })
  update(
    @Param('code') code: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.templates.update(code, dto, actor);
  }

  @Post(':code/reset')
  @ApiOperation({
    summary: 'Put a template back to the wording that shipped',
    description: 'The way out of an edit that reads badly, without hunting for the original text.',
  })
  reset(@Param('code') code: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.templates.resetToDefault(code, actor);
  }
}

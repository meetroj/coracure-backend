import { Global, Module, OnModuleInit } from '@nestjs/common';

import { AppConfigService } from '../app-config/app-config.service';
import { env } from '../config/env.validation';
import {
  FORBIDDEN_TERMS,
  FORBIDDEN_TERMS_KEY,
  TEMPLATES_KEY,
  defaultTemplateCopy,
  forbiddenTermsSchema,
} from './notification-templates';
import {
  AdminNotificationTemplatesController,
  NotificationsController,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { FirebasePushProvider } from './push/firebase.provider';
import { LogPushProvider } from './push/log.provider';
import { PUSH_PROVIDER } from './push/push.provider';
import { NotificationTemplatesService } from './templates.service';

/**
 * M-08 Notifications. Owns `notifications`.
 *
 * Global because almost every module after it raises one: M-11 confirms a
 * booking, M-13 routes an instant request, M-15 chases documentation, M-16
 * raises the safety alerts. They all call `NotificationsService.notify` and
 * none of them knows what a device token is.
 *
 * It depends only on M-01 and M-02, and deliberately on nothing later. A module
 * that everything calls must not call anything back, or the first alert would
 * pull half the platform into its dependency graph.
 */
@Global()
@Module({
  controllers: [NotificationsController, AdminNotificationTemplatesController],
  providers: [
    NotificationsService,
    NotificationTemplatesService,
    {
      provide: PUSH_PROVIDER,
      // `env.validation` refuses the log provider in production, so a
      // deployment cannot silently stop notifying anybody.
      useClass: env().PUSH_PROVIDER === 'fcm' ? FirebasePushProvider : LogPushProvider,
    },
  ],
  exports: [NotificationsService, NotificationTemplatesService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /**
   * The copy and the forbidden-term list become admin-editable data on first
   * boot. `seed` never overwrites, so a redeploy cannot undo an admin's
   * rewording - which is the whole point of FR-16.3.
   */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: TEMPLATES_KEY,
        value: defaultTemplateCopy(),
        description:
          'What every notification says, keyed by template code (FR-16.3). Edited from the admin panel; a change is live without an app release.',
        // Has its own screen, which validates more than a shape check could.
        managedBy: 'notification templates',
      },
      {
        key: FORBIDDEN_TERMS_KEY,
        value: FORBIDDEN_TERMS,
        description:
          'Words a notification may never contain (FR-16.2). Checked when copy is saved and again on the rendered text.',
        schema: forbiddenTermsSchema,
        editableBy: ['clinical_governance', 'content'],
      },
    ]);
  }
}

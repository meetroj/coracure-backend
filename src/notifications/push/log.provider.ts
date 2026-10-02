import { Injectable, Logger } from '@nestjs/common';

import { PushMessage, PushProvider, PushResult } from './push.provider';

/**
 * Delivers nothing, and says exactly what it would have delivered.
 *
 * This is what runs until the Firebase service accounts exist. Every flow that
 * raises a notification - booking, reminders, safety alerts - can be driven end
 * to end without credentials, and the notification row is written either way,
 * so the in-app inbox is fully working before any key is added.
 *
 * `env.validation` refuses to boot production with this selected, so a
 * deployment cannot quietly stop notifying anybody.
 */
@Injectable()
export class LogPushProvider implements PushProvider {
  private readonly logger = new Logger(LogPushProvider.name);

  send(message: PushMessage): Promise<PushResult> {
    this.logger.log(
      {
        audience: message.audience,
        // The token identifies a device, so only its tail is logged - enough to
        // tell two devices apart in a support call, never enough to push to one.
        token: `…${message.token.slice(-8)}`,
        title: message.title,
        body: message.body,
        data: message.data,
      },
      'Log push provider - nothing was sent',
    );
    // Reported as delivered on purpose. The alternative marks every row in
    // development `failed`, which would make the one status worth watching
    // meaningless exactly where it is most read.
    return Promise.resolve({ delivered: true });
  }
}

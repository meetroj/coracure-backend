import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { SELF_SETTABLE } from '../presence.service';

/**
 * Only the four a provider sets for themselves. The other three -
 * `request_pending`, `in_consultation`, `completing_notes` - are moved by the
 * platform as things happen, and a provider who could set them by hand could
 * hide behind one for ever.
 */
export class SetPresenceDto {
  @ApiProperty({
    enum: SELF_SETTABLE,
    description: '`scheduled_only` stays bookable by slot but takes no instant requests (FR-10.3).',
  })
  @IsIn(SELF_SETTABLE)
  presence!: (typeof SELF_SETTABLE)[number];
}

import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { AppConfigService } from './app-config.service';
import { SetConfigDto } from './dto/app-config.dto';

/**
 * The settings screen behind FR-7.5, FR-13.7 and FR-16.3's "configurable from
 * the admin panel".
 *
 * *** ONLY VALUES A MODULE REGISTERED. ***
 *
 * The registry is built by the modules that own the values, so this endpoint
 * knows three things about every key it offers: what the value is for, what
 * shape the reading code expects, and which admin level owns it. A key nobody
 * registered is refused — nothing reads it, so changing it would do nothing,
 * and offering it would imply otherwise.
 *
 * *** THE SHAPE CHECK IS THE POINT. *** A configuration table is the easiest
 * place in a platform to put a string where a number goes and not find out
 * until the next checkout fails for every patient. Every write here is parsed
 * against the same schema the reading module validates with.
 *
 * Values with a screen of their own — notification templates, the allocation
 * policy, the crisis keywords — are listed but not editable here, and say where
 * to go instead. Two ways to change one value is how the two drift apart, and
 * the specialised screen usually validates something this one cannot.
 */
@ApiTags('admin/config')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/config', version: '1' })
export class AppConfigController {
  constructor(private readonly config: AppConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Every configurable value, and whether you may change it',
    description:
      '`editable` is false where your admin level does not own the setting, or where it has a dedicated screen — `managedBy` then names that screen. The description on each value says what it does and what the trade-off is in setting it wrongly.',
  })
  list(@CurrentActor() actor: AuthenticatedActor) {
    return this.config.listForAdmin(actor);
  }

  @Put(':key')
  @ApiOperation({
    summary: 'Change one value',
    description:
      'Refused unless the key is registered, your level owns it, and the new value is the shape the reading module expects. The change is recorded in the audit log with the before and after — that entry IS the configuration history, which is why there is no versions table.',
  })
  set(
    @Param('key') key: string,
    @Body() dto: SetConfigDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.config.setFromAdmin(key, dto.value, actor);
  }
}

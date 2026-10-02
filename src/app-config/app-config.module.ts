import { Global, Module } from '@nestjs/common';

import { AppConfigController } from './app-config.controller';
import { AppConfigService } from './app-config.service';

/**
 * M-01's configuration store. Global: any module may hold configuration as data
 * (SRS 6.6).
 *
 * The controller is the settings screen FR-7.5, FR-13.7 and FR-16.3 assume.
 * It serves only what modules REGISTERED - so what is editable, what shape it
 * must take and who owns it are all declared by the module that reads the
 * value, in the same call that seeds its default.
 */
@Global()
@Module({
  controllers: [AppConfigController],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}

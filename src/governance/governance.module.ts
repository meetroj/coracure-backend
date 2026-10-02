import { Global, Module } from '@nestjs/common';

import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';

/**
 * M-20 Governance and Quality. Owns NO TABLES.
 *
 * Every queue and every metric is read from the module that owns the rows, so a
 * dashboard figure can never disagree with its source - which is precisely
 * M-20's completion criterion. It follows M-11 to M-19 because it reads all of
 * them, and nothing depends on it.
 *
 * Global only so M-21 can share its CSV writer. Nothing else here is injected
 * anywhere: a control room reads, and is not read from.
 */
@Global()
@Module({
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService],
})
export class GovernanceModule {}

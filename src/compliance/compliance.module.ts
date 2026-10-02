import { Global, Module, OnModuleInit } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { ComplianceController, PatientDataRightsController } from './compliance.controller';
import {
  DEFAULT_RETENTION_DAYS,
  RETENTION_DAYS_KEY,
  ComplianceService,
} from './compliance.service';
import {
  DEFAULT_RETENTION_SWEEP_ENABLED,
  RETENTION_SWEEP_ENABLED_KEY,
  RetentionSweeperService,
} from './retention-sweeper.service';
import { SubjectAccessService } from './subject-access.service';

/**
 * M-21 Audit, Compliance and Data Rights. Owns NO TABLES.
 *
 * `audit_log` is M-01's, because every module writes to it from its first
 * release. Retention is an `app_config` value. Deletion evidence is columns on
 * M-03's request row. This module owns the BEHAVIOUR over all three - the
 * search, the retention sweep and the erasure run - and adds no storage of its
 * own to a trail whose value is that nothing rewrites it.
 *
 * Last in the build order because it reads what every other module wrote.
 */
@Global()
@Module({
  controllers: [ComplianceController, PatientDataRightsController],
  providers: [ComplianceService, SubjectAccessService, RetentionSweeperService],
  exports: [ComplianceService, SubjectAccessService],
})
export class ComplianceModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /** SRS 5.3: retention is the CLIENT's to set, so it is a config value. */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: RETENTION_DAYS_KEY,
        value: DEFAULT_RETENTION_DAYS,
        description:
          'Days an audit entry is kept before the retention sweep removes it (SRS 5.3). The default is deliberately long — an entry deleted too early cannot be recovered, while one kept too long is a storage cost. Eight years is the common Indian medical-records expectation; the client’s counsel sets the real figure.',
        schema: z.number().int().min(365).max(7300),
        editableBy: [],
      },
      {
        key: RETENTION_SWEEP_ENABLED_KEY,
        value: DEFAULT_RETENTION_SWEEP_ENABLED,
        description:
          'Whether the nightly retention sweep runs. Ships OFF: it deletes audit entries irreversibly, and until the retention period above has been signed off the shipped default is a guess. Turn it on once that figure is confirmed — a super admin can run the sweep by hand first and read the count.',
        schema: z.boolean(),
        editableBy: [],
      },
    ]);
  }
}

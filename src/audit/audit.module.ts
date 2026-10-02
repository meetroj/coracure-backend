import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';

/** Global: every module writes to the trail from its first release (MODULES 7). */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

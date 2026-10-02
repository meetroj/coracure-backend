import { Module } from '@nestjs/common';

import { ClinicalTemplatesController } from './clinical-templates.controller';
import { ClinicalTemplatesService } from './clinical-templates.service';

/** A doctor's own reusable prescription templates. Owns `clinical_templates`. */
@Module({
  controllers: [ClinicalTemplatesController],
  providers: [ClinicalTemplatesService],
})
export class ClinicalTemplatesModule {}

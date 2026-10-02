import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppConfigModule } from './app-config/app-config.module';
import { AuditModule } from './audit/audit.module';
import { BookingModule } from './booking/booking.module';
import { ClinicalModule } from './clinical/clinical.module';
import { ClarificationModule } from './clarification/clarification.module';
import { ClinicalTemplatesModule } from './clinical-templates/clinical-templates.module';
import { ComplianceModule } from './compliance/compliance.module';
import { CommonModule } from './common/common.module';
import { ContentModule } from './content/content.module';
import { validateEnvironment } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { DoctorsModule } from './doctors/doctors.module';
import { FilesModule } from './files/files.module';
import { FollowupModule } from './followup/followup.module';
import { GovernanceModule } from './governance/governance.module';
import { HealthModule } from './health/health.module';
import { InstantModule } from './instant/instant.module';
import { IdentityModule } from './identity/identity.module';
import { LegalModule } from './legal/legal.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PatientsModule } from './patients/patients.module';
import { PaymentsModule } from './payments/payments.module';
import { SearchModule } from './search/search.module';
import { SupportModule } from './support/support.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { VideoModule } from './video/video.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    // A blunt per-IP ceiling. The OTP and admin-login limits are M-02's, counted
    // from the audit log so they survive a restart and apply per identifier.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DatabaseModule,
    AuditModule,
    AppConfigModule,
    // *** ORDER MATTERS *** global guards run in the order their modules are
    // resolved. IdentityModule's AuthGuard must put `request.actor` in place
    // before CommonModule's RolesGuard reads it, so it is listed first.
    IdentityModule,
    CommonModule,
    LegalModule,
    // M-08 depends only on M-01 and M-02, and everything later raises through
    // it, so it is resolved before the modules that will.
    NotificationsModule,
    PatientsModule,
    // *** ORDER MATTERS *** M-06 binds the SPECIALTY_CATALOGUE port that M-05
    // declares, so the catalogue is resolved before the registry that injects it.
    CatalogueModule,
    DoctorsModule,
    // M-07 reads doctors through M-05's registry, so it follows it.
    SchedulingModule,
    // M-09 reads M-06's catalogue and asks M-07 when a pool can next cover a
    // service, so it follows both. It never reads the provider roster.
    SearchModule,
    // M-10 gates doctor reads with M-05's @VerifiedDoctorsOnly(), so it follows
    // the registry. Everything about a consultation comes through its own port.
    FilesModule,
    // *** ORDER MATTERS *** M-11 BINDS the four ports M-04, M-05, M-07 and M-10
    // declare, so it is registered after all of them. Each of those modules
    // stopped providing its own closed default when this arrived - a module's
    // own provider wins over a global one, so leaving the default in place
    // would have kept every one of them shut.
    BookingModule,
    // M-12 tells M-11 when the money arrived, so it follows booking.
    PaymentsModule,
    // M-13 routes by M-11's assignment rules, so it follows booking.
    InstantModule,
    // M-14 issues a join token only for a consultation that exists, has both
    // its parties and has been paid for, so it follows M-11 and M-12. LiveKit
    // itself is NOT here - it is a separate container carrying the media.
    VideoModule,
    // M-15 writes up a consultation that has been HELD, so it follows M-14, and
    // it opens M-13's completion gate when the documentation is finished.
    ClinicalModule,
    // M-16 assigns a follow-up plan once M-15's record is finalised, and reads
    // it again to compose the Care Plan, so it follows M-15.
    FollowupModule,
    // M-17 raises a de-identified case out of a consultation M-15 has written
    // up, and reads M-05's expert seniority to decide who may be asked.
    ClarificationModule,
    // Doctor-owned prescription templates; depends on nothing but the database.
    ClinicalTemplatesModule,
    // *** ORDER MATTERS *** M-18 BINDS the `CONTENT_LIBRARY` port M-15 declares
    // and M-16 reads, so it is registered after both. M-15 keeps its closed
    // default provider, which a later global binding overrides.
    ContentModule,
    // M-19 writes M-11's feedback columns and reads its consultations, so it
    // follows booking. It depends on nothing later.
    SupportModule,
    // M-20 reads every module above and owns nothing, so it is registered after
    // all of them. Nothing depends on it: a control room reads, and is not read
    // from.
    GovernanceModule,
    // M-21 is last, because it reads what every other module wrote. It adds no
    // storage of its own to a trail whose value is that nothing rewrites it.
    ComplianceModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

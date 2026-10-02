import { Body, Controller, Get, Param, ParseEnumPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DeletionStatus, LegalDocumentType } from '@prisma/client';
import { FastifyRequest } from 'fastify';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { Public } from '../identity/public.decorator';
import { ConsentsService } from './consents.service';
import { DataDeletionService } from './data-deletion.service';
import {
  AcceptConsentDto,
  LEGAL_DOCUMENT_TYPES,
  PublishLegalDocumentDto,
  RequestDeletionDto,
  ReviewDeletionDto,
} from './dto/legal.dto';
import { LegalDocumentsService } from './legal-documents.service';

const DOCUMENT_TYPE_PIPE = new ParseEnumPipe(
  Object.fromEntries(LEGAL_DOCUMENT_TYPES.map((type) => [type, type])),
);

@ApiTags('legal')
@Controller({ version: '1' })
export class LegalController {
  constructor(
    private readonly documents: LegalDocumentsService,
    private readonly consents: ConsentsService,
    private readonly deletion: DataDeletionService,
  ) {}

  // -- Legal copy, readable by anyone -----------------------------------------
  // FR-2.4 puts the privacy policy and terms in the app, and the store review
  // process reaches them before anyone has an account.

  @Public()
  @Get('legal/documents')
  @ApiOperation({ summary: 'Every current legal document, without its body' })
  listCurrent() {
    return this.documents.listCurrent();
  }

  @Public()
  @Get('legal/documents/:documentType')
  @ApiOperation({ summary: 'The full text of the current version of one document' })
  getCurrent(@Param('documentType', DOCUMENT_TYPE_PIPE) documentType: LegalDocumentType) {
    return this.documents.getCurrent(documentType);
  }

  // -- Consent ----------------------------------------------------------------

  @Roles('patient', 'doctor')
  @ApiBearerAuth()
  @Post('legal/consents')
  @ApiOperation({
    summary: 'Accept the current version of a legal document',
    description:
      'Records the version, the time, the person and their IP as legal evidence (FR-2.3). Accepting twice is a no-op, so a retried request is not an error.',
  })
  accept(
    @Body() dto: AcceptConsentDto,
    @CurrentActor() actor: AuthenticatedActor,
    @Req() request: FastifyRequest,
  ) {
    return this.consents.accept(actor, dto.documentType, { ipAddress: request.ip });
  }

  @Roles('patient', 'doctor')
  @ApiBearerAuth()
  @Get('legal/consents/me')
  @ApiOperation({ summary: 'Everything I have accepted, and which version of it' })
  listMine(@CurrentActor() actor: AuthenticatedActor) {
    return this.consents.listFor(actor);
  }

  @Roles('patient', 'doctor')
  @ApiBearerAuth()
  @Get('legal/consents/me/status')
  @ApiOperation({
    summary: 'Whether I have accepted the CURRENT version of each document',
    description:
      'What the app checks before offering a booking. Publishing a new version turns `teleconsultationConsent` false again until it is re-accepted.',
  })
  async myStatus(@CurrentActor() actor: AuthenticatedActor) {
    const [teleconsultationConsent, privacyPolicy, termsOfUse] = await Promise.all([
      this.consents.hasCurrentConsent(actor, 'teleconsultation_consent'),
      this.consents.hasCurrentConsent(actor, 'privacy_policy'),
      this.consents.hasCurrentConsent(actor, 'terms_of_use'),
    ]);
    return { teleconsultationConsent, privacyPolicy, termsOfUse };
  }

  // -- Data deletion, patient side (FR-2.5) -----------------------------------

  @Roles('patient')
  @ApiBearerAuth()
  @Post('me/deletion-requests')
  @ApiOperation({ summary: 'Ask for my data to be deleted' })
  requestDeletion(
    @Body() dto: RequestDeletionDto,
    @CurrentActor() actor: AuthenticatedActor,
    @Req() request: FastifyRequest,
  ) {
    return this.deletion.request(actor.id, dto.reason, { ipAddress: request.ip });
  }

  @Roles('patient')
  @ApiBearerAuth()
  @Get('me/deletion-requests')
  @ApiOperation({ summary: 'My deletion requests and where each one has got to' })
  listMyDeletionRequests(@CurrentActor() actor: AuthenticatedActor) {
    return this.deletion.listForPatient(actor.id);
  }

  // -- Admin ------------------------------------------------------------------

  @Roles('admin')
  @ApiBearerAuth()
  @Post('admin/legal/documents')
  @ApiOperation({
    summary: 'Publish a new version of a legal document',
    description:
      'Always an insert. The previous current version is demoted in the same transaction and kept forever, so every consent still resolves to the exact text accepted.',
  })
  publish(@Body() dto: PublishLegalDocumentDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.documents.publish(dto, actor);
  }

  @Roles('admin')
  @ApiBearerAuth()
  @Get('admin/legal/documents/:documentType/versions')
  @ApiOperation({ summary: 'Every version of one document, newest first' })
  listVersions(
    @Param('documentType', DOCUMENT_TYPE_PIPE) documentType: LegalDocumentType,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'content', 'clinical_governance', 'operations');
    return this.documents.listVersions(documentType);
  }

  @Roles('admin')
  @ApiBearerAuth()
  @Get('admin/deletion-requests')
  @ApiOperation({ summary: 'The deletion queue, oldest first' })
  listDeletionRequests(
    @CurrentActor() actor: AuthenticatedActor,
    @Query('status') status?: DeletionStatus,
  ) {
    assertPermission(actor, 'operations');
    return this.deletion.listForReview(status);
  }

  @Roles('admin')
  @ApiBearerAuth()
  @Post('admin/deletion-requests/:id/review')
  @ApiOperation({
    summary: 'Decide a deletion request',
    description:
      '`approved` authorises the execution M-21 runs; it does not delete anything. `executed_at` is what says the run happened.',
  })
  reviewDeletionRequest(
    @Param('id') id: string,
    @Body() dto: ReviewDeletionDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations');
    return this.deletion.review(id, dto, actor);
  }
}

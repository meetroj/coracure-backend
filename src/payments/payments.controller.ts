import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { Public } from '../identity/public.decorator';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { ExportKindDto, MarkPayoutPaidDto, RefundDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

/** The patient's bill and checkout (FR-4.7). */
@ApiTags('payments')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/consultations/:consultationId', version: '1' })
export class PatientPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('checkout')
  @ApiOperation({
    summary: 'Open checkout for a held consultation (FR-7.1)',
    description:
      'Freezes the bill on the payment row and returns what the gateway SDK needs. The consultation is not paid by this call — only a verified webhook does that (FR-7.6).',
  })
  checkout(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.payments.startCheckout(id, actor.id);
  }

  @Get('bill')
  @ApiOperation({
    summary: 'My bill, every component separately (FR-7.2)',
    description:
      'Consultation fee, convenience fee, subtotal before GST, GST and final payable — plus refund status where there is one (FR-7.7).',
  })
  bill(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.payments.billFor(id, actor);
  }
}

/** What the provider is owed (FR-7.4, FR-9.9). */
@ApiTags('payments')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor', version: '1' })
export class DoctorPayoutsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payouts')
  @ApiOperation({
    summary: 'My earnings (FR-9.9)',
    description:
      'Each row shows the consultation fee, a platform deduction of ZERO, and the earning — stated rather than implied, so it is clear nothing was taken.',
  })
  payouts(@CurrentActor() actor: AuthenticatedActor) {
    return this.payments.payoutsForDoctor(actor.id);
  }

  @Get('consultations/:consultationId/payout')
  @ApiOperation({ summary: 'What I am owed for one consultation (FR-7.4)' })
  payout(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.payments.payoutFor(id, actor.id);
  }
}

/**
 * *** THE WEBHOOK. THE ONLY WAY A PAYMENT BECOMES PAID (FR-7.6). ***
 *
 * `@Public()` because the gateway has no bearer token — its identity IS the
 * HMAC signature over the raw body, which is checked before anything is read.
 * That makes the signature the whole of the authentication, which is why
 * `env.validation` refuses to boot production without a webhook secret.
 *
 * The RAW body is used, not the parsed one: re-serialising JSON changes key
 * order and whitespace, and the signature is over the bytes that were sent.
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  handle(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    // An empty body or a missing header still goes through verification, so a
    // caller cannot tell "not signed" from "signed wrongly" by the response.
    return this.payments.handleWebhook(request.rawBody?.toString('utf8') ?? '', signature ?? '');
  }
}

/**
 * Refunds, payouts and exports (FR-7.5, FR-7.7, FR-18.4).
 *
 * `finance` runs the money. `operations` is here too for refunds, because a
 * refund is usually the tail end of a cancellation somebody in operations is
 * already handling, and making them hand it over would slow the patient's
 * money down for no benefit.
 */
@ApiTags('admin/payments')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/payments', version: '1' })
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payouts/pending')
  @ApiOperation({
    summary: 'What the platform still owes providers',
    description:
      'Payouts are made BY HAND this release, so this is a report rather than a job. The queue is "captured but not yet transferred".',
  })
  pendingPayouts(@CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'finance');
    return this.payments.pendingPayouts();
  }

  @Post(':consultationId/refund')
  @ApiOperation({
    summary: 'Refund a payment (FR-7.7)',
    description:
      'Raised from the panel only. Omit `amount` to refund the whole charge. Never more than was charged — a CHECK enforces the same ceiling.',
  })
  refund(
    @Param('consultationId') id: string,
    @Body() dto: RefundDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'finance', 'operations');
    return this.payments.refund(id, dto, actor);
  }

  @Post(':consultationId/payout')
  @ApiOperation({
    summary: 'Record that a provider was paid',
    description:
      'There is no `payout_reference` column: no screen prints a bank reference, so the reference given here goes into the audit entry, which is where a later question about it is answered.',
  })
  markPaid(
    @Param('consultationId') id: string,
    @Body() dto: MarkPayoutPaidDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'finance');
    return this.payments.markPayoutPaid(id, dto.reference, actor);
  }

  @Get('export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'Transactions or refunds as CSV (FR-18.4)' })
  async export(@Query() query: ExportKindDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'finance');
    return this.payments.exportCsv(query.kind ?? 'transactions');
  }
}

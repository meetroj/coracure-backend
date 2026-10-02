import { Global, Module, OnModuleInit } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { env } from '../config/env.validation';
import { PAYMENT_GATEWAY } from './gateway/payment-gateway';
import { RazorpayGateway } from './gateway/razorpay.gateway';
import { StubPaymentGateway } from './gateway/stub.gateway';
import {
  AdminPaymentsController,
  DoctorPayoutsController,
  PatientPaymentsController,
  PaymentWebhookController,
} from './payments.controller';
import {
  CONVENIENCE_FEE_PCT_KEY,
  DEFAULT_CONVENIENCE_FEE_PCT,
  DEFAULT_GST_PCT,
  GST_PCT_KEY,
  PaymentsService,
} from './payments.service';

/**
 * M-12 Payments and Billing. Owns `payments`, one row per consultation.
 *
 * Global because M-14 will not issue a video join token for a consultation
 * nobody paid for, and M-20 reports on what is owed.
 *
 * It depends on M-11 rather than the other way round: booking creates the
 * consultation and owns its status, and this module tells it when the money
 * arrived. Nothing in M-11 knows what a gateway is.
 */
@Global()
@Module({
  controllers: [
    PatientPaymentsController,
    DoctorPayoutsController,
    PaymentWebhookController,
    AdminPaymentsController,
  ],
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_GATEWAY,
      // `env.validation` refuses the stub in production, so a deployment cannot
      // silently take no money while looking perfectly healthy.
      useClass: env().PAYMENT_GATEWAY === 'razorpay' ? RazorpayGateway : StubPaymentGateway,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /** FR-7.5: the two rates are admin-editable, and these are FR-7.3's figures. */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: CONVENIENCE_FEE_PCT_KEY,
        value: DEFAULT_CONVENIENCE_FEE_PCT,
        description:
          'Convenience fee as a percentage of the consultation fee (FR-7.3, FR-7.5). Charged on top of the provider’s fee, never out of it.',
        schema: z.number().min(0).max(100),
        editableBy: ['finance'],
      },
      {
        key: GST_PCT_KEY,
        value: DEFAULT_GST_PCT,
        description:
          'GST as a percentage, charged EXCLUSIVE on the subtotal (fee + convenience fee) — FR-7.3. Confirm with the client’s CA before launch (SRS 8).',
        schema: z.number().min(0).max(100),
        editableBy: ['finance'],
      },
    ]);
  }
}

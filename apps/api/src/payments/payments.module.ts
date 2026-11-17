import { Module } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER, createPaymentProvider } from './provider';

@Module({
  imports: [LedgerModule],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) => createPaymentProvider(env),
    },
    PaymentsService,
  ],
})
export class PaymentsModule {}

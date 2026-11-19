import { Module } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { LedgerModule } from '../ledger/ledger.module';
import { ExamLifecycleController } from './exam-lifecycle.controller';
import { ExamLifecycleService } from './exam-lifecycle.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER, createPaymentProvider } from './provider';

@Module({
  imports: [LedgerModule],
  controllers: [PaymentsController, ExamLifecycleController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) => createPaymentProvider(env),
    },
    PaymentsService,
    ExamLifecycleService,
  ],
})
export class PaymentsModule {}

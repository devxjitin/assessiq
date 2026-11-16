import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

/**
 * Root module. Feature modules (auth, users, exams, questions, attempts, payments, ledger,
 * payouts, certificates, ...) are added sprint by sprint - see ASSESSIQ_IMPLEMENTATION_PLAN.md.
 */
@Module({ controllers: [HealthController] })
export class AppModule {}

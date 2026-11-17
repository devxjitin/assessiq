import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ConfigModule } from './config/config.module';
import { PaymentsModule } from './payments/payments.module';
import { ExamsModule } from './exams/exams.module';
import { HealthController } from './health/health.controller';
import { StorageModule } from './storage/storage.module';
import { MailModule } from './mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

/**
 * Root module. Feature modules (exams, questions, attempts, payments, ledger, payouts,
 * certificates, ...) are added sprint by sprint - see ASSESSIQ_IMPLEMENTATION_PLAN.md.
 *
 * Guard order matters: throttle -> authenticate -> authorise by role.
 */
@Module({
  imports: [
    // Generous global limit; auth routes set a stricter one. Off in tests.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ConfigModule,
    PrismaModule,
    AuditModule,
    MailModule,
    StorageModule,
    AuthModule,
    UsersModule,
    AdminModule,
    ExamsModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

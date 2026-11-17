import { Module } from '@nestjs/common';
import { CertificatesModule } from '../certificates/certificates.module';
import { GradingService } from './grading.service';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';

@Module({
  imports: [CertificatesModule],
  controllers: [ResultsController],
  providers: [GradingService, ResultsService],
  exports: [GradingService, ResultsService],
})
export class ResultsModule {}

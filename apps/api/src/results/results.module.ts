import { Module } from '@nestjs/common';
import { GradingService } from './grading.service';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';

@Module({
  controllers: [ResultsController],
  providers: [GradingService, ResultsService],
  exports: [GradingService, ResultsService],
})
export class ResultsModule {}

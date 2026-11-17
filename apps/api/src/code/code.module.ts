import { Global, Module } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { ResultsModule } from '../results/results.module';
import { CODE_RUNNER, createRunner } from './code-runner';
import { CodeJudgeService } from './code-judge.service';

@Global()
@Module({
  imports: [ResultsModule],
  providers: [
    { provide: CODE_RUNNER, inject: [ENV], useFactory: (env: Env) => createRunner(env) },
    CodeJudgeService,
  ],
  exports: [CODE_RUNNER, CodeJudgeService],
})
export class CodeModule {}

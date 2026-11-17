import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  codingMarks,
  outputsMatch,
  type CodingSpec,
  type GradedTest,
  type TestStatus,
} from '@assessiq/shared';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { GradingService } from '../results/grading.service';
import { CODE_RUNNER, CodeRunner, RunOutcome } from './code-runner';

/** A job still marked RUNNING after this long belongs to a crashed process; take it over. */
const STALE_MS = 5 * 60_000;
/** After this many infrastructure failures the job gives up and the trainer marks it by hand. */
const MAX_TRIES = 5;
/** Wait this long before retrying a job whose sandbox call failed. */
const RETRY_AFTER_MS = 30_000;

export function toTestStatus(o: RunOutcome, matches: boolean): TestStatus {
  switch (o.status) {
    case 'OK':
      return matches ? 'PASSED' : 'WRONG_ANSWER';
    case 'COMPILE_ERROR':
    case 'RUNTIME_ERROR':
    case 'TIME_LIMIT':
    case 'MEMORY_LIMIT':
    case 'ERROR':
      return o.status;
  }
}

/**
 * Grades coding answers in the background. Jobs live in the database, so nothing is lost if the
 * server restarts, and several servers can share the queue (a job is claimed atomically).
 */
@Injectable()
export class CodeJudgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodeJudgeService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly grading: GradingService,
    @Inject(CODE_RUNNER) private readonly runner: CodeRunner,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    if (this.env.CODE_JUDGE_POLL === 'on' && this.runner.available) {
      this.timer = setInterval(() => void this.tick(), 2000);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.drain();
    } catch (err) {
      this.logger.error(`judge loop failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Processes queued jobs, a few at a time, until none are left. Returns how many finished. */
  async drain(): Promise<number> {
    let done = 0;
    for (;;) {
      const batch = await Promise.all(
        Array.from({ length: this.env.CODE_JUDGE_CONCURRENCY }, () => this.claimAndJudge()),
      );
      // Only jobs this call actually judged count; a lost claim just means look again.
      done += batch.filter((r) => r === 'judged').length;
      if (batch.every((r) => r === 'idle')) return done;
    }
  }

  /** Claims and grades one job. False when nothing was claimed. */
  async processOne(): Promise<boolean> {
    return (await this.claimAndJudge()) !== 'idle';
  }

  /** 'judged' when this call graded a job, 'lost' when another worker claimed it first. */
  private async claimAndJudge(): Promise<'judged' | 'lost' | 'idle'> {
    if (!this.runner.available) return 'idle';
    const stale = new Date(Date.now() - STALE_MS);
    const retryable = new Date(Date.now() - RETRY_AFTER_MS);
    // A queued job with a lock time is one that failed recently; it waits before another try.
    const claimable = [
      { status: 'QUEUED' as const, lockedAt: null },
      { status: 'QUEUED' as const, lockedAt: { lt: retryable } },
      { status: 'RUNNING' as const, lockedAt: { lt: stale } },
    ];
    const candidate = await this.prisma.codeSubmission.findFirst({
      where: { OR: claimable },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return 'idle';
    const claimed = await this.prisma.codeSubmission.updateMany({
      where: { id: candidate.id, OR: claimable },
      data: { status: 'RUNNING', lockedAt: new Date(), tries: { increment: 1 } },
    });
    if (claimed.count === 0) return 'lost'; // someone else took it; try the next one
    await this.judge(candidate.id);
    return 'judged';
  }

  private async judge(jobId: string): Promise<void> {
    const job = await this.prisma.codeSubmission.findUniqueOrThrow({ where: { id: jobId } });
    const question = await this.prisma.question.findUnique({ where: { id: job.questionId } });
    const spec = question?.coding as unknown as CodingSpec | null;
    if (!question || !spec) {
      await this.fail(job.id, 'The question no longer has test cases');
      return;
    }

    const graded: GradedTest[] = [];
    try {
      for (const t of spec.testCases) {
        const out = await this.runner.run({
          language: job.language as never,
          source: job.source,
          stdin: t.input,
          timeLimitMs: spec.timeLimitMs,
          memoryMb: spec.memoryMb,
        });
        const status = toTestStatus(
          out,
          out.status === 'OK' && outputsMatch(t.expectedOutput, out.stdout),
        );
        graded.push({
          testId: t.id,
          hidden: t.hidden,
          status,
          passed: status === 'PASSED',
          timeMs: out.timeMs,
        });
      }
    } catch (err) {
      // The sandbox could not be reached: put the job back and try again later.
      const tries = job.tries;
      this.logger.warn(`job ${job.id} attempt ${tries} failed: ${(err as Error).message}`);
      if (tries >= MAX_TRIES) await this.fail(job.id, (err as Error).message);
      else {
        await this.prisma.codeSubmission.update({
          where: { id: job.id },
          data: {
            status: 'QUEUED',
            lockedAt: new Date(), // marks when it failed; retried after a pause
            error: (err as Error).message.slice(0, 300),
          },
        });
      }
      return;
    }

    const { marks, passedWeight, totalWeight } = codingMarks(
      question.marks,
      spec.testCases.map((t, i) => ({ weight: t.weight, passed: graded[i].passed })),
    );
    const answer = await this.prisma.answer.findUnique({
      where: { attemptId_questionId: { attemptId: job.attemptId, questionId: job.questionId } },
    });
    await this.prisma.$transaction([
      this.prisma.codeSubmission.update({
        where: { id: job.id },
        data: {
          status: 'DONE',
          passedWeight,
          totalWeight,
          results: graded as unknown as object,
          error: null,
          finishedAt: new Date(),
        },
      }),
      // A trainer who already marked this answer by hand keeps their marks.
      ...(answer && answer.marksAwarded === null
        ? [
            this.prisma.answer.update({
              where: { id: answer.id },
              data: { marksAwarded: marks, gradedAt: new Date() },
            }),
          ]
        : []),
    ]);
    await this.grading.gradeAttempt(job.attemptId);
  }

  private async fail(jobId: string, error: string) {
    await this.prisma.codeSubmission.update({
      where: { id: jobId },
      data: { status: 'ERROR', error: error.slice(0, 300), finishedAt: new Date() },
    });
  }
}

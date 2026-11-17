import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Attempt, Prisma, Question } from '@prisma/client';
import { randomInt } from 'node:crypto';
import {
  LIMITS,
  STRIKE_EVENTS,
  type AttemptDto,
  type ProctorEventInput,
  type SaveAnswerInput,
} from '@assessiq/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { GRACE_MS } from '../common/timing';
import { PrismaService } from '../prisma/prisma.service';
import { GradingService } from '../results/grading.service';

/** Blur and tab-hidden usually fire together; events this close count as one strike. */
const STRIKE_DEBOUNCE_MS = 2000;

const UUID = /^[0-9a-f-]{36}$/i;

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

@Injectable()
export class AttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly grading: GradingService,
  ) {}

  // ------------------------------------------------------------------ start

  /** Starts the student's attempt, or returns the one already running. */
  async start(user: AuthUser, enrollmentId: string): Promise<AttemptDto> {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { id: enrollmentId, studentId: user.id },
      include: {
        attempt: true,
        exam: { include: { questions: { orderBy: { position: 'asc' } } } },
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.attempt) return this.view(user, enrollment.attempt.id);

    const { exam } = enrollment;
    const now = new Date();
    if (exam.status !== 'PUBLISHED') throw new ConflictException('This exam is not available');
    if (exam.startsAt && exam.startsAt > now)
      throw new ConflictException('This exam has not opened yet');
    if (exam.endsAt && exam.endsAt <= now) throw new ConflictException('This exam has ended');

    const byDuration = new Date(now.getTime() + exam.durationMinutes * 60_000);
    const deadlineAt = exam.endsAt && exam.endsAt < byDuration ? exam.endsAt : byDuration;

    const ids = exam.questions.map((q) => q.id);
    const questionOrder = exam.shuffleQuestions ? shuffled(ids) : ids;
    const optionOrders: Record<string, number[]> = {};
    for (const q of exam.questions) {
      if (q.type === 'SINGLE' || q.type === 'MULTI') {
        const idx = q.options.map((_, i) => i);
        optionOrders[q.id] = exam.shuffleOptions ? shuffled(idx) : idx;
      }
    }

    let attemptId: string;
    try {
      const created = await this.prisma.attempt.create({
        data: {
          enrollmentId: enrollment.id,
          examId: exam.id,
          studentId: user.id,
          startedAt: now,
          deadlineAt,
          questionOrder,
          optionOrders,
        },
      });
      attemptId = created.id;
      await this.audit.log({
        actorId: user.id,
        action: 'attempt.start',
        entity: 'Attempt',
        entityId: created.id,
      });
    } catch (err) {
      // Two tabs starting at once: the second one gets the first one's attempt.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.attempt.findUniqueOrThrow({
          where: { enrollmentId: enrollment.id },
        });
        attemptId = existing.id;
      } else {
        throw err;
      }
    }
    return this.view(user, attemptId);
  }

  // ------------------------------------------------------------------- read

  async view(user: AuthUser, attemptId: string): Promise<AttemptDto> {
    const attempt = await this.load(user, attemptId);
    const exam = await this.prisma.exam.findUniqueOrThrow({
      where: { id: attempt.examId },
      include: { questions: true },
    });
    const live = attempt.status === 'IN_PROGRESS';

    const answers: AttemptDto['answers'] = {};
    let questions: AttemptDto['questions'] = [];
    if (live) {
      const byId = new Map<string, Question>(exam.questions.map((q) => [q.id, q]));
      const order = attempt.questionOrder as string[];
      const optionOrders = attempt.optionOrders as Record<string, number[]>;
      questions = order.flatMap((id, i) => {
        const q = byId.get(id);
        if (!q) return [];
        return [
          {
            id: q.id,
            number: i + 1,
            type: q.type as 'SINGLE' | 'MULTI' | 'SUBJECTIVE',
            body: q.body,
            marks: q.marks,
            negativeMarks: q.negativeMarks,
            options: (optionOrders[q.id] ?? []).map((idx) => ({ id: idx, text: q.options[idx] })),
          },
        ];
      });
      const saved = await this.prisma.answer.findMany({ where: { attemptId } });
      for (const a of saved) {
        answers[a.questionId] = { selected: a.selected, text: a.text ?? '', flagged: a.flagged };
      }
    }

    return {
      id: attempt.id,
      status: attempt.status,
      endReason: attempt.endReason,
      serverTime: new Date().toISOString(),
      deadlineAt: attempt.deadlineAt.toISOString(),
      strikes: attempt.strikes,
      maxStrikes: LIMITS.MAX_STRIKES,
      exam: {
        title: exam.title,
        instructions: exam.instructions,
        durationMinutes: exam.durationMinutes,
      },
      questions,
      answers,
    };
  }

  // --------------------------------------------------------------- autosave

  async saveAnswer(
    user: AuthUser,
    attemptId: string,
    questionId: string,
    input: SaveAnswerInput,
  ): Promise<{ saved: true }> {
    const attempt = await this.load(user, attemptId);
    this.assertWritable(attempt);

    const order = attempt.questionOrder as string[];
    if (!UUID.test(questionId) || !order.includes(questionId)) {
      throw new NotFoundException('Question not found');
    }
    const question = await this.prisma.question.findUniqueOrThrow({ where: { id: questionId } });

    let selected: number[] | undefined;
    let text: string | undefined;
    if (question.type === 'SUBJECTIVE') {
      text = input.text;
    } else if (input.selected !== undefined) {
      const unique = [...new Set(input.selected)];
      if (unique.some((i) => i >= question.options.length)) {
        throw new ConflictException('That option does not exist');
      }
      if (question.type === 'SINGLE' && unique.length > 1) {
        throw new ConflictException('Only one option can be selected');
      }
      selected = unique.sort((a, b) => a - b);
    }

    await this.prisma.answer.upsert({
      where: { attemptId_questionId: { attemptId, questionId } },
      create: {
        attemptId,
        questionId,
        selected: selected ?? [],
        text: text ?? null,
        flagged: input.flagged ?? false,
      },
      update: { selected, text, flagged: input.flagged },
    });
    return { saved: true };
  }

  // ----------------------------------------------------------------- submit

  async submit(user: AuthUser, attemptId: string): Promise<AttemptDto> {
    const attempt = await this.load(user, attemptId);
    if (attempt.status === 'IN_PROGRESS') {
      this.assertWritable(attempt);
      await this.prisma.attempt.updateMany({
        where: { id: attemptId, status: 'IN_PROGRESS' },
        data: { status: 'SUBMITTED', endReason: 'SUBMITTED_BY_STUDENT', submittedAt: new Date() },
      });
      await this.grading.gradeAttempt(attemptId);
      await this.audit.log({
        actorId: user.id,
        action: 'attempt.submit',
        entity: 'Attempt',
        entityId: attemptId,
      });
    }
    return this.view(user, attemptId);
  }

  // ---------------------------------------------------------------- proctor

  /**
   * The browser reports what it saw; the server decides what it costs. A student who edits the
   * client cannot lower their strikes, only stop reporting them (which is why this is
   * advisory evidence for the trainer, not proof).
   */
  async recordEvent(user: AuthUser, attemptId: string, input: ProctorEventInput) {
    const attempt = await this.load(user, attemptId);
    if (attempt.status !== 'IN_PROGRESS') {
      return { strikes: attempt.strikes, ended: true, status: attempt.status };
    }
    const now = new Date();
    let strike = false;
    if (STRIKE_EVENTS.includes(input.type)) {
      const last = await this.prisma.proctorEvent.findFirst({
        where: { attemptId, strike: true },
        orderBy: { createdAt: 'desc' },
      });
      strike = !last || now.getTime() - last.createdAt.getTime() > STRIKE_DEBOUNCE_MS;
    }
    await this.prisma.proctorEvent.create({ data: { attemptId, type: input.type, strike } });

    let strikes = attempt.strikes;
    let status: string = attempt.status;
    if (strike) {
      const updated = await this.prisma.attempt.update({
        where: { id: attemptId },
        data: { strikes: { increment: 1 } },
      });
      strikes = updated.strikes;
      if (strikes >= LIMITS.MAX_STRIKES) {
        await this.prisma.attempt.updateMany({
          where: { id: attemptId, status: 'IN_PROGRESS' },
          data: { status: 'AUTO_SUBMITTED', endReason: 'STRIKES', submittedAt: now },
        });
        status = 'AUTO_SUBMITTED';
        await this.grading.gradeAttempt(attemptId);
        await this.audit.log({
          actorId: user.id,
          action: 'attempt.strikes.autosubmit',
          entity: 'Attempt',
          entityId: attemptId,
        });
      }
    }
    return { strikes, ended: status !== 'IN_PROGRESS', status };
  }

  // ---------------------------------------------------------------- helpers

  /** Loads the caller's own attempt and applies the time limit if it has run out. */
  private async load(user: AuthUser, attemptId: string): Promise<Attempt> {
    const attempt = UUID.test(attemptId)
      ? await this.prisma.attempt.findFirst({ where: { id: attemptId, studentId: user.id } })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    return this.settle(attempt);
  }

  /** Auto-submits an attempt whose time is up. Lazy, so no timer has to be running. */
  async settle(attempt: Attempt): Promise<Attempt> {
    const overdue =
      attempt.status === 'IN_PROGRESS' && Date.now() >= attempt.deadlineAt.getTime() + GRACE_MS;
    if (!overdue) return attempt;
    await this.prisma.attempt.updateMany({
      where: { id: attempt.id, status: 'IN_PROGRESS' },
      data: { status: 'AUTO_SUBMITTED', endReason: 'TIME_UP', submittedAt: attempt.deadlineAt },
    });
    await this.grading.gradeAttempt(attempt.id);
    return this.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
  }

  private assertWritable(attempt: Attempt): void {
    if (attempt.status !== 'IN_PROGRESS') {
      throw new ConflictException('This attempt has already ended');
    }
    if (Date.now() >= attempt.deadlineAt.getTime() + GRACE_MS) {
      throw new ConflictException('Time is up');
    }
  }
}

import { Injectable } from '@nestjs/common';
import { gradeChoice, summarize } from '@assessiq/shared';
import { GRACE_MS } from '../common/timing';
import { PrismaService } from '../prisma/prisma.service';

/** Scores attempts. Choice questions are marked by the server; subjective ones wait for the trainer. */
@Injectable()
export class GradingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Marks every choice answer of a finished attempt and, once nothing is waiting for the
   * trainer, stores the total. Safe to call again at any time; it never touches an attempt
   * whose results have been published, or the marks a trainer has already given.
   */
  async gradeAttempt(attemptId: string): Promise<void> {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { answers: true, exam: { include: { questions: true } } },
    });
    if (!attempt || attempt.status === 'IN_PROGRESS' || attempt.status === 'RESULT_PUBLISHED') {
      return;
    }
    const byQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
    const now = new Date();
    const writes = [];
    const awarded: number[] = [];
    let pending = 0;

    // With a question pool, only the questions this student was given count.
    const given = new Set(attempt.questionOrder as string[]);
    const questions = attempt.exam.questions.filter((q) => given.has(q.id));

    for (const q of questions) {
      const a = byQuestion.get(q.id);
      if (q.droppedAt) {
        // Dropped by the trainer: full marks for everyone, nothing to read or judge.
        awarded.push(q.marks);
        continue;
      }
      if (q.type !== 'SINGLE' && q.type !== 'MULTI') {
        // Written answers (coding questions will join them in a later sprint).

        if (!a?.text?.trim()) {
          awarded.push(0); // left blank: nothing to read, nothing to award
        } else if (a.marksAwarded === null) {
          pending++;
          if (q.type === 'CODING') {
            // Queue it for automatic judging; the unique key makes this safe to repeat.
            writes.push(
              this.prisma.codeSubmission.upsert({
                where: { attemptId_questionId: { attemptId: attempt.id, questionId: q.id } },
                create: {
                  attemptId: attempt.id,
                  questionId: q.id,
                  language: a.language ?? 'python',
                  source: a.text ?? '',
                },
                update: {},
              }),
            );
          }
        } else {
          awarded.push(a.marksAwarded);
        }
        continue;
      }
      const g = gradeChoice(
        {
          type: q.type,
          correctOptions: q.correctOptions,
          marks: q.marks,
          negativeMarks: q.negativeMarks,
          partialCredit: q.partialCredit,
        },
        a?.selected ?? [],
      );
      // A mark the trainer set by hand wins over the automatic one.
      const marks = a?.marksOverride ?? g.marks;
      awarded.push(marks);
      if (a && a.marksAwarded !== marks) {
        writes.push(
          this.prisma.answer.update({
            where: { id: a.id },
            data: { marksAwarded: marks, gradedAt: now },
          }),
        );
      }
    }

    if (pending === 0) {
      const maxScore = questions.reduce((s, q) => s + q.marks, 0);
      const result = summarize({ awarded, maxScore, passPercent: attempt.exam.passPercent });
      writes.push(
        this.prisma.attempt.update({
          where: { id: attempt.id },
          data: { ...result, gradedAt: now, status: 'GRADED' },
        }),
      );
    } else {
      writes.push(
        this.prisma.attempt.update({
          where: { id: attempt.id },
          data: { score: null, maxScore: null, percent: null, passed: null, gradedAt: null },
        }),
      );
    }
    await this.prisma.$transaction(writes);
  }

  /**
   * Ends attempts whose time ran out without anyone opening them again, then marks them. Students
   * who simply closed the tab would otherwise stay "in progress" for ever.
   */
  async settleOverdue(examId: string): Promise<number> {
    const cutoff = new Date(Date.now() - GRACE_MS);
    const overdue = await this.prisma.attempt.findMany({
      where: { examId, status: 'IN_PROGRESS', deadlineAt: { lt: cutoff } },
    });
    for (const a of overdue) {
      const flipped = await this.prisma.attempt.updateMany({
        where: { id: a.id, status: 'IN_PROGRESS' },
        data: { status: 'AUTO_SUBMITTED', endReason: 'TIME_UP', submittedAt: a.deadlineAt },
      });
      if (flipped.count) await this.gradeAttempt(a.id);
    }
    return overdue.length;
  }
}

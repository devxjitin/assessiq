import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  round2,
  type AttemptRowDto,
  type ExamResultsDto,
  type GradeAnswerInput,
  type GradingAttemptDto,
  type StudentResultDto,
} from '@assessiq/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { GradingService } from './grading.service';

const UUID = /^[0-9a-f-]{36}$/i;

/** Spreadsheet programs run cells that start with these as formulas; names come from users. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grading: GradingService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- trainer

  private async findOwned(user: AuthUser, examId: string) {
    const exam = UUID.test(examId)
      ? await this.prisma.exam.findFirst({
          where: { id: examId, examinerId: user.id },
          include: { questions: { orderBy: { position: 'asc' } } },
        })
      : null;
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  /** Brings every attempt up to date: time-outs applied, choice answers marked. */
  private async refresh(examId: string): Promise<void> {
    await this.grading.settleOverdue(examId);
    const stale = await this.prisma.attempt.findMany({
      where: {
        examId,
        status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] },
        score: null,
        answers: { none: { marksAwarded: { not: null } } },
      },
      select: { id: true },
    });
    for (const a of stale) await this.grading.gradeAttempt(a.id);
  }

  async results(user: AuthUser, examId: string): Promise<ExamResultsDto> {
    const exam = await this.findOwned(user, examId);
    await this.refresh(exam.id);

    const subjectiveIds = exam.questions.filter((q) => q.type === 'SUBJECTIVE').map((q) => q.id);
    const attempts = await this.prisma.attempt.findMany({
      where: { examId: exam.id },
      orderBy: { startedAt: 'asc' },
      include: {
        student: { select: { name: true, email: true } },
        answers: { where: { questionId: { in: subjectiveIds } } },
        _count: { select: { events: true } },
      },
    });
    const enrolled = await this.prisma.enrollment.count({ where: { examId: exam.id } });

    const rows: AttemptRowDto[] = attempts.map((a) => ({
      attemptId: a.id,
      studentName: a.student.name,
      studentEmail: a.student.email,
      status: a.status,
      endReason: a.endReason,
      startedAt: a.startedAt.toISOString(),
      submittedAt: a.submittedAt?.toISOString() ?? null,
      strikes: a.strikes,
      violations: a._count.events,
      pendingGrading: a.answers.filter((x) => x.text?.trim() && x.marksAwarded === null).length,
      score: a.score,
      percent: a.percent,
      passed: a.passed,
    }));

    const scored = rows.filter((r) => r.percent !== null);
    return {
      exam: {
        id: exam.id,
        title: exam.title,
        status: exam.status,
        passPercent: exam.passPercent,
        totalMarks: round2(exam.questions.reduce((s, q) => s + q.marks, 0)),
        enrolled,
      },
      stats: {
        attempts: rows.length,
        submitted: rows.filter((r) => r.status !== 'IN_PROGRESS').length,
        inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
        pendingGrading: rows.reduce((s, r) => s + r.pendingGrading, 0),
        average: scored.length
          ? round2(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length)
          : null,
        highest: scored.length ? Math.max(...scored.map((r) => r.score ?? 0)) : null,
        passRate: scored.length
          ? round2((scored.filter((r) => r.passed).length / scored.length) * 100)
          : null,
      },
      finalized: exam.status === 'RESULTS_FINAL',
      rows,
    };
  }

  async attemptDetail(
    user: AuthUser,
    examId: string,
    attemptId: string,
  ): Promise<GradingAttemptDto> {
    const exam = await this.findOwned(user, examId);
    await this.grading.settleOverdue(exam.id);
    const attempt = UUID.test(attemptId)
      ? await this.prisma.attempt.findFirst({
          where: { id: attemptId, examId: exam.id },
          include: {
            student: { select: { name: true, email: true } },
            answers: true,
            events: { orderBy: { createdAt: 'asc' } },
          },
        })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status === 'IN_PROGRESS') {
      throw new ConflictException('This student is still taking the exam');
    }

    const byQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
    return {
      attemptId: attempt.id,
      examId: exam.id,
      studentName: attempt.student.name,
      studentEmail: attempt.student.email,
      status: attempt.status,
      endReason: attempt.endReason,
      strikes: attempt.strikes,
      events: attempt.events.map((e) => ({
        type: e.type,
        strike: e.strike,
        at: e.createdAt.toISOString(),
      })),
      finalized: exam.status === 'RESULTS_FINAL',
      result:
        attempt.score !== null
          ? {
              score: attempt.score,
              maxScore: attempt.maxScore ?? 0,
              percent: attempt.percent ?? 0,
              passed: Boolean(attempt.passed),
            }
          : null,
      questions: exam.questions.map((q, i) => {
        const a = byQuestion.get(q.id);
        const blankWritten = q.type === 'SUBJECTIVE' && !a?.text?.trim();
        return {
          questionId: q.id,
          number: i + 1,
          type: q.type as 'SINGLE' | 'MULTI' | 'SUBJECTIVE',
          body: q.body,
          options: q.options,
          correctOptions: q.correctOptions,
          marks: q.marks,
          negativeMarks: q.negativeMarks,
          explanation: q.explanation,
          rubric: q.rubric,
          selected: a?.selected ?? [],
          text: a?.text ?? null,
          // null means "still waiting for the trainer"; a blank written answer is simply 0.
          marksAwarded: a?.marksAwarded ?? (q.type !== 'SUBJECTIVE' || blankWritten ? 0 : null),
          feedback: a?.feedback ?? null,
        };
      }),
    };
  }

  async gradeAnswer(
    user: AuthUser,
    examId: string,
    attemptId: string,
    questionId: string,
    input: GradeAnswerInput,
  ): Promise<{ saved: true }> {
    const exam = await this.findOwned(user, examId);
    if (exam.status === 'RESULTS_FINAL') {
      throw new ConflictException('Results are published, so marks can no longer change');
    }
    const question = exam.questions.find((q) => q.id === questionId);
    if (!question || question.type !== 'SUBJECTIVE') {
      throw new NotFoundException('Question not found');
    }
    if (input.marks > question.marks) {
      throw new ConflictException(`Marks cannot be more than ${question.marks}`);
    }
    const attempt = UUID.test(attemptId)
      ? await this.prisma.attempt.findFirst({ where: { id: attemptId, examId: exam.id } })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status === 'IN_PROGRESS') {
      throw new ConflictException('This student is still taking the exam');
    }
    const answer = await this.prisma.answer.findUnique({
      where: { attemptId_questionId: { attemptId, questionId } },
    });
    if (!answer?.text?.trim()) throw new ConflictException('There is no written answer to mark');

    await this.prisma.answer.update({
      where: { id: answer.id },
      data: { marksAwarded: input.marks, feedback: input.feedback ?? null, gradedAt: new Date() },
    });
    await this.grading.gradeAttempt(attemptId);
    await this.audit.log({
      actorId: user.id,
      action: 'answer.grade',
      entity: 'Answer',
      entityId: answer.id,
      meta: { marks: input.marks },
    });
    return { saved: true };
  }

  /** Publishes results to students. Needs every written answer marked and the exam closed. */
  async finalize(user: AuthUser, examId: string): Promise<ExamResultsDto> {
    const exam = await this.findOwned(user, examId);
    if (exam.status === 'RESULTS_FINAL') {
      throw new ConflictException('Results are already published');
    }
    if (exam.status !== 'PUBLISHED') {
      throw new ConflictException('This exam has not been published');
    }
    if (exam.endsAt && exam.endsAt > new Date()) {
      throw new ConflictException(
        'The exam is still open until ' +
          exam.endsAt.toISOString() +
          '; publish results after it closes',
      );
    }
    await this.refresh(exam.id);

    const live = await this.prisma.attempt.count({
      where: { examId: exam.id, status: 'IN_PROGRESS' },
    });
    if (live > 0) throw new ConflictException(live + ' student(s) are still taking the exam');

    const unmarked = await this.prisma.attempt.count({
      where: { examId: exam.id, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
    });
    if (unmarked > 0) {
      throw new ConflictException(
        unmarked + ' attempt(s) still have written answers to mark before results can be published',
      );
    }

    await this.prisma.$transaction([
      this.prisma.exam.update({
        where: { id: exam.id },
        data: { status: 'RESULTS_FINAL', resultsPublishedAt: new Date() },
      }),
      this.prisma.attempt.updateMany({
        where: { examId: exam.id, status: 'GRADED' },
        data: { status: 'RESULT_PUBLISHED' },
      }),
    ]);
    await this.audit.log({
      actorId: user.id,
      action: 'exam.results.publish',
      entity: 'Exam',
      entityId: exam.id,
    });
    return this.results(user, examId);
  }

  async csv(user: AuthUser, examId: string): Promise<{ filename: string; body: string }> {
    const data = await this.results(user, examId);
    const header = [
      'Name',
      'Email',
      'Status',
      'Submitted at',
      'Score',
      'Out of',
      'Percent',
      'Result',
      'Strikes',
      'Violations',
      'Ended by',
    ];
    const lines = data.rows.map((r) =>
      [
        r.studentName,
        r.studentEmail,
        r.status,
        r.submittedAt,
        r.score,
        r.score === null ? null : data.exam.totalMarks,
        r.percent,
        r.passed === null ? '' : r.passed ? 'Pass' : 'Fail',
        r.strikes,
        r.violations,
        r.endReason,
      ]
        .map(csvCell)
        .join(','),
    );
    const slug = data.exam.title
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return {
      filename: (slug || 'exam') + '-results.csv',
      body: [header.join(','), ...lines].join('\r\n') + '\r\n',
    };
  }

  // ---------------------------------------------------------------- student

  async studentResult(user: AuthUser, attemptId: string): Promise<StudentResultDto> {
    const attempt = UUID.test(attemptId)
      ? await this.prisma.attempt.findFirst({
          where: { id: attemptId, studentId: user.id },
          include: { answers: true, exam: { include: { questions: true } } },
        })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status !== 'RESULT_PUBLISHED' || attempt.score === null) {
      throw new ConflictException('Results have not been published yet');
    }
    const byQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
    const byId = new Map(attempt.exam.questions.map((q) => [q.id, q]));
    const order = attempt.questionOrder as string[];
    return {
      attemptId: attempt.id,
      examTitle: attempt.exam.title,
      passPercent: attempt.exam.passPercent,
      score: attempt.score,
      maxScore: attempt.maxScore ?? 0,
      percent: attempt.percent ?? 0,
      passed: Boolean(attempt.passed),
      questions: order.flatMap((id, i) => {
        const q = byId.get(id);
        if (!q) return [];
        const a = byQuestion.get(id);
        return [
          {
            number: i + 1,
            type: q.type as 'SINGLE' | 'MULTI' | 'SUBJECTIVE',
            body: q.body,
            options: q.options,
            correctOptions: q.correctOptions,
            selected: a?.selected ?? [],
            text: a?.text ?? null,
            marks: q.marks,
            marksAwarded: a?.marksAwarded ?? 0,
            explanation: q.explanation,
            feedback: a?.feedback ?? null,
          },
        ];
      }),
    };
  }
}

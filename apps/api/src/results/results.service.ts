import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CodeSubmission } from '@prisma/client';
import {
  INTEGRITY,
  findSimilar,
  integrityFlags,
  round2,
  type CodingSpec,
  type SimilarityReportDto,
  type CodeSubmissionDto,
  type GradedTest,
  type AttemptRowDto,
  type ExamResultsDto,
  type GradeAnswerInput,
  type GradingAttemptDto,
  type StudentResultDto,
} from '@assessiq/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { CertificatesService } from '../certificates/certificates.service';
import { GradingService } from './grading.service';

const UUID = /^[0-9a-f-]{36}$/i;

function toSubmission(job: CodeSubmission | undefined): CodeSubmissionDto | null {
  if (!job) return null;
  return {
    status: job.status,
    passedWeight: job.passedWeight ?? 0,
    totalWeight: job.totalWeight ?? 0,
    tests: (job.results as unknown as GradedTest[] | null) ?? [],
  };
}

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
    private readonly certificates: CertificatesService,
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

    const writtenIds = exam.questions
      .filter((q) => q.type === 'SUBJECTIVE' || q.type === 'CODING')
      .map((q) => q.id);
    const attempts = await this.prisma.attempt.findMany({
      where: { examId: exam.id },
      orderBy: { startedAt: 'asc' },
      include: {
        student: { select: { name: true, email: true } },
        answers: { where: { questionId: { in: writtenIds } } },
        events: { where: { type: 'DEVICE_MISMATCH' }, select: { id: true } },
        _count: { select: { events: true } },
      },
    });
    const devices = new Map<string, number>();
    for (const a of attempts) {
      if (a.deviceId) devices.set(a.deviceId, (devices.get(a.deviceId) ?? 0) + 1);
    }
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
      flags: integrityFlags({
        hasDeviceId: Boolean(a.deviceId),
        sharedDeviceCount: a.deviceId ? (devices.get(a.deviceId) ?? 1) - 1 : 0,
        mismatchEvents: a.events.length,
        startIp: a.startIp,
        lastIp: a.lastIp,
      }).map((x) => x.code),
      score: a.score,
      maxScore: a.maxScore,
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
        totalMarks: this.totalFor(exam),
        questionsPerStudent: exam.questionsPerStudent,
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
            codeJobs: true,
          },
        })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status === 'IN_PROGRESS') {
      throw new ConflictException('This student is still taking the exam');
    }

    const byQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
    const jobs = new Map(attempt.codeJobs.map((j) => [j.questionId, j]));
    // Only the questions this student was given (a question pool gives each student a subset).
    const given = new Set(attempt.questionOrder as string[]);
    const asked = exam.questions.filter((q) => given.has(q.id));
    const sharing = attempt.deviceId
      ? await this.prisma.attempt.findMany({
          where: { examId: exam.id, deviceId: attempt.deviceId, id: { not: attempt.id } },
          select: { student: { select: { name: true, email: true } } },
        })
      : [];
    const integrity = {
      startIp: attempt.startIp,
      lastIp: attempt.lastIp,
      userAgent: attempt.userAgent,
      hasDeviceId: Boolean(attempt.deviceId),
      sharedWith: sharing.map((x) => x.student),
      flags: integrityFlags({
        hasDeviceId: Boolean(attempt.deviceId),
        sharedDeviceCount: sharing.length,
        mismatchEvents: attempt.events.filter((e) => e.type === 'DEVICE_MISMATCH').length,
        startIp: attempt.startIp,
        lastIp: attempt.lastIp,
      }),
    };
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
        ip: e.ip,
      })),
      integrity,
      pooled: asked.length < exam.questions.length,
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
      questions: asked.map((q, i) => {
        const a = byQuestion.get(q.id);
        const written = q.type === 'SUBJECTIVE' || q.type === 'CODING';
        const blankWritten = written && !a?.text?.trim();
        return {
          questionId: q.id,
          number: i + 1,
          type: q.type,
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
          language: a?.language ?? null,
          submission: toSubmission(jobs.get(q.id)),
          marksAwarded: a?.marksAwarded ?? (!written || blankWritten ? 0 : null),
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
    if (!question || (question.type !== 'SUBJECTIVE' && question.type !== 'CODING')) {
      throw new NotFoundException('Question not found');
    }
    if (input.marks > question.marks) {
      throw new ConflictException(`Marks cannot be more than ${question.marks}`);
    }
    const attempt = UUID.test(attemptId)
      ? await this.prisma.attempt.findFirst({ where: { id: attemptId, examId: exam.id } })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (!(attempt.questionOrder as string[]).includes(questionId)) {
      throw new NotFoundException('Question not found');
    }
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
    // Certificates are made (and queued for NandiVex to approve) from the published results.
    // A problem here must never undo the publication itself.
    try {
      await this.certificates.createForExam(exam.id);
    } catch (err) {
      console.error('Could not create certificates for exam', exam.id, err);
    }
    return this.results(user, examId);
  }

  /** Total marks shown for the exam; with a question pool this is the typical total per student. */
  private totalFor(exam: { questions: { marks: number }[]; questionsPerStudent: number | null }) {
    const total = exam.questions.reduce((s, q) => s + q.marks, 0);
    const n = exam.questions.length;
    const shown = exam.questionsPerStudent ? Math.min(exam.questionsPerStudent, n) : n;
    return round2(n ? (total / n) * shown : 0);
  }

  /** Lets a student continue a running attempt from a different device. */
  async releaseDevice(
    user: AuthUser,
    examId: string,
    attemptId: string,
  ): Promise<{ released: true }> {
    const exam = await this.findOwned(user, examId);
    const attempt = UUID.test(attemptId)
      ? await this.prisma.attempt.findFirst({ where: { id: attemptId, examId: exam.id } })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status !== 'IN_PROGRESS') {
      throw new ConflictException('This attempt has already ended');
    }
    await this.prisma.attempt.update({ where: { id: attempt.id }, data: { deviceId: null } });
    await this.audit.log({
      actorId: user.id,
      action: 'attempt.device.release',
      entity: 'Attempt',
      entityId: attempt.id,
    });
    return { released: true };
  }

  /** Pairs of coding answers that are very alike, per question and language. */
  async similarity(
    user: AuthUser,
    examId: string,
    threshold?: number,
  ): Promise<SimilarityReportDto> {
    const exam = await this.findOwned(user, examId);
    const limit =
      threshold && threshold >= 0.3 && threshold <= 1 ? threshold : INTEGRITY.SIMILARITY_THRESHOLD;
    const report: SimilarityReportDto = { threshold: limit, questions: [] };
    for (const [i, q] of exam.questions.entries()) {
      if (q.type !== 'CODING') continue;
      const answers = await this.prisma.answer.findMany({
        where: {
          questionId: q.id,
          text: { not: null },
          attempt: { examId: exam.id, status: { not: 'IN_PROGRESS' } },
        },
        include: {
          attempt: { select: { id: true, student: { select: { name: true, email: true } } } },
        },
      });
      const spec = q.coding as unknown as CodingSpec | null;
      const people = new Map(answers.map((a) => [a.attempt.id, a.attempt.student]));
      const pairs: SimilarityReportDto['questions'][number]['pairs'] = [];
      let compared = 0;
      for (const lang of new Set(answers.map((a) => a.language ?? 'python'))) {
        const group = answers
          .filter((a) => (a.language ?? 'python') === lang && a.text?.trim())
          .map((a) => ({ attemptId: a.attempt.id, source: a.text ?? '' }));
        const found = findSimilar(group, {
          threshold: limit,
          starter: spec?.starterCode?.[lang as keyof typeof spec.starterCode],
        });
        compared += found.compared;
        for (const h of found.hits) {
          pairs.push({
            similarity: Math.round(h.score * 100),
            a: { attemptId: h.a, ...people.get(h.a)! },
            b: { attemptId: h.b, ...people.get(h.b)! },
          });
        }
      }
      pairs.sort((x, y) => y.similarity - x.similarity);
      report.questions.push({
        questionId: q.id,
        number: i + 1,
        body: q.body.slice(0, 160),
        compared,
        pairs: pairs.slice(0, 100),
      });
    }
    return report;
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
        r.maxScore,
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
          include: {
            answers: true,
            codeJobs: true,
            exam: { include: { questions: true } },
          },
        })
      : null;
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status !== 'RESULT_PUBLISHED' || attempt.score === null) {
      throw new ConflictException('Results have not been published yet');
    }
    const byQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
    const byId = new Map(attempt.exam.questions.map((q) => [q.id, q]));
    const jobs = new Map(attempt.codeJobs.map((j) => [j.questionId, j]));
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
            type: q.type,
            body: q.body,
            options: q.options,
            correctOptions: q.correctOptions,
            selected: a?.selected ?? [],
            text: a?.text ?? null,
            language: a?.language ?? null,
            submission: toSubmission(jobs.get(id)),
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

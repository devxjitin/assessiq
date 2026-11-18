import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Exam, Question } from '@prisma/client';
import {
  PRACTICE,
  gradeChoice,
  outputsMatch,
  summarize,
  toStudentCoding,
  type CodingSpec,
  type PracticeCheckInput,
  type PracticeCodeTest,
  type PracticeFeedbackDto,
  type PracticeQuestionDto,
  type PracticeRoundDto,
  type PracticeSetDto,
  type PracticeSubmitInput,
  type PracticeSummaryDto,
} from '@assessiq/shared';
import type { AuthUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { CODE_RUNNER, CodeRunner } from '../code/code-runner';
import { toTestStatus } from '../code/code-judge.service';
import { GradingService } from '../results/grading.service';

const UUID = /^[0-9a-f-]{36}$/i;
const OVER = ['RESULTS_FINAL', 'CANCELLED'];

const DAY_MS = 86_400_000;

type Type = 'SINGLE' | 'MULTI' | 'SUBJECTIVE' | 'CODING';

/**
 * Practice sets. A student who took an exam can practise its questions once the exam is over
 * (so answers cannot leak to people still sitting it). Nothing here touches official attempts.
 */
@Injectable()
export class PracticeService {
  /** Last feedback request per student and question, to slow down guessing and code runs. */
  private readonly lastCheck = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly grading: GradingService,
    @Inject(CODE_RUNNER) private readonly runner: CodeRunner,
  ) {}

  private isOver(exam: Pick<Exam, 'status' | 'endsAt'>): boolean {
    if (OVER.includes(exam.status)) return true;
    return (
      exam.status === 'PUBLISHED' && exam.endsAt !== null && exam.endsAt.getTime() <= Date.now()
    );
  }

  /** When the exam closed: its end time, or else when results came out. */
  private closedAt(exam: Pick<Exam, 'endsAt' | 'resultsPublishedAt' | 'updatedAt'>): Date {
    return exam.endsAt ?? exam.resultsPublishedAt ?? exam.updatedAt;
  }

  private expiresAt(exam: Pick<Exam, 'endsAt' | 'resultsPublishedAt' | 'updatedAt'>): Date {
    return new Date(this.closedAt(exam).getTime() + PRACTICE.EXPIRY_DAYS * DAY_MS);
  }

  /** 403 unless the exam is over and this student handed in an attempt. */
  private async unlock(user: AuthUser, examId: string) {
    if (!UUID.test(examId)) throw new NotFoundException('Practice set not found');
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: { questions: { orderBy: { position: 'asc' } } },
    });
    if (!exam) throw new NotFoundException('Practice set not found');
    if (!this.isOver(exam)) {
      throw new ForbiddenException('Practice opens after the exam has closed');
    }
    if (this.expiresAt(exam).getTime() <= Date.now()) {
      throw new ForbiddenException(
        `This practice set expired ${PRACTICE.EXPIRY_DAYS} days after the exam closed`,
      );
    }
    // Students who closed the tab are still "in progress" until someone settles them.
    await this.grading.settleOverdue(examId);
    const took = await this.prisma.attempt.findFirst({
      where: { examId, studentId: user.id, status: { not: 'IN_PROGRESS' } },
      select: { id: true },
    });
    if (!took) {
      throw new ForbiddenException('Practice is only for students who took this exam');
    }
    await this.prisma.practiceAccess.upsert({
      where: { studentId_examId: { studentId: user.id, examId } },
      create: { studentId: user.id, examId },
      update: {},
    });
    return exam;
  }

  // ------------------------------------------------------------------- listing

  async mine(user: AuthUser): Promise<PracticeSummaryDto[]> {
    const attempts = await this.prisma.attempt.findMany({
      where: { studentId: user.id, status: { not: 'IN_PROGRESS' } },
      include: {
        exam: {
          include: {
            examiner: { select: { name: true } },
            questions: { select: { type: true } },
          },
        },
      },
    });
    const open = attempts.filter(
      (a) => this.isOver(a.exam) && this.expiresAt(a.exam).getTime() > Date.now(),
    );
    if (open.length === 0) return [];
    const rounds = await this.prisma.practiceRound.groupBy({
      by: ['examId'],
      where: { studentId: user.id, examId: { in: open.map((a) => a.examId) } },
      _count: { _all: true },
      _max: { percent: true, createdAt: true },
    });
    const byExam = new Map(rounds.map((r) => [r.examId, r]));
    return open
      .map((a) => {
        const r = byExam.get(a.examId);
        return {
          examId: a.examId,
          title: a.exam.title,
          trainerName: a.exam.examiner.name,
          questionCount: a.exam.questions.length,
          scoredCount: a.exam.questions.filter((q) => q.type === 'SINGLE' || q.type === 'MULTI')
            .length,
          rounds: r?._count._all ?? 0,
          bestPercent: r?._max.percent ?? null,
          lastRoundAt: r?._max.createdAt?.toISOString() ?? null,
          expiresAt: this.expiresAt(a.exam).toISOString(),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  // --------------------------------------------------------------------- the set

  async set(user: AuthUser, examId: string): Promise<PracticeSetDto> {
    const exam = await this.unlock(user, examId);
    return {
      examId,
      title: exam.title,
      expiresAt: this.expiresAt(exam).toISOString(),
      questions: exam.questions.map((q, i) => this.toDto(q, i + 1)),
    };
  }

  private toDto(q: Question, number: number): PracticeQuestionDto {
    return {
      id: q.id,
      number,
      type: q.type as Type,
      body: q.body,
      marks: q.marks,
      options: q.options,
      ...(q.type === 'CODING' && q.coding
        ? { coding: toStudentCoding(q.coding as unknown as CodingSpec) }
        : {}),
    };
  }

  // ------------------------------------------------------------ instant feedback

  async check(
    user: AuthUser,
    examId: string,
    questionId: string,
    input: PracticeCheckInput,
  ): Promise<PracticeFeedbackDto> {
    const exam = await this.unlock(user, examId);
    const q = UUID.test(questionId) ? exam.questions.find((x) => x.id === questionId) : undefined;
    if (!q) throw new NotFoundException('Question not found');
    const type = q.type as Type;

    const base = {
      questionId: q.id,
      type,
      maxMarks: q.marks,
      explanation: q.explanation,
    };

    if (type === 'SINGLE' || type === 'MULTI') {
      const g = gradeChoice(
        {
          type,
          correctOptions: q.correctOptions,
          marks: q.marks,
          negativeMarks: q.negativeMarks,
          partialCredit: q.partialCredit,
        },
        input.selected ?? [],
      );
      return {
        ...base,
        correct: g.outcome === 'UNANSWERED' ? false : g.outcome === 'CORRECT',
        marks: g.marks,
        correctOptions: q.correctOptions,
        guidance: null,
      };
    }

    if (type === 'SUBJECTIVE') {
      // Cannot be marked automatically: show what a good answer covers.
      return { ...base, correct: null, marks: null, correctOptions: [], guidance: q.rubric };
    }

    return this.checkCode(user, q, input, base);
  }

  private async checkCode(
    user: AuthUser,
    q: Question,
    input: PracticeCheckInput,
    base: Pick<PracticeFeedbackDto, 'questionId' | 'type' | 'maxMarks' | 'explanation'>,
  ): Promise<PracticeFeedbackDto> {
    const spec = q.coding as unknown as CodingSpec | null;
    if (!spec) throw new NotFoundException('Question not found');
    const language = input.language;
    const source = input.text ?? '';
    if (!language || !spec.languages.includes(language)) {
      throw new ConflictException('Choose one of the allowed languages');
    }
    if (!source.trim()) throw new ConflictException('Write some code first');
    if (!this.runner.available) {
      throw new ServiceUnavailableException('Running code is not available right now');
    }
    this.cooldown(user.id, q.id);

    const tests: PracticeCodeTest[] = [];
    for (const t of spec.testCases) {
      try {
        const out = await this.runner.run({
          language,
          source,
          stdin: t.input,
          timeLimitMs: spec.timeLimitMs,
          memoryMb: spec.memoryMb,
        });
        const passed = out.status === 'OK' && outputsMatch(t.expectedOutput, out.stdout);
        const status = toTestStatus(out, passed);
        tests.push(
          t.hidden
            ? { hidden: true, passed, status, timeMs: out.timeMs }
            : {
                hidden: false,
                passed,
                status,
                input: t.input,
                expectedOutput: t.expectedOutput,
                actualOutput: out.stdout.slice(0, 2000),
                message: out.stderr.slice(0, 1000),
                timeMs: out.timeMs,
              },
        );
      } catch {
        this.lastCheck.delete(`${user.id}:${q.id}`);
        throw new ServiceUnavailableException('Running code is not available right now');
      }
    }
    const allPassed = tests.every((t) => t.passed);
    return {
      ...base,
      correct: allPassed,
      marks: null,
      correctOptions: [],
      guidance: null,
      tests,
    };
  }

  private cooldown(userId: string, questionId: string): void {
    const key = `${userId}:${questionId}`;
    const now = Date.now();
    const last = this.lastCheck.get(key) ?? 0;
    if (now - last < PRACTICE.CHECK_COOLDOWN_MS) {
      throw new HttpException('Wait a few seconds between runs', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastCheck.set(key, now);
    if (this.lastCheck.size > 5000) {
      for (const [k, t] of this.lastCheck) if (now - t > 60_000) this.lastCheck.delete(k);
    }
  }

  // ------------------------------------------------------------------ rounds

  /** Scores a round of choice answers and keeps it in the history. */
  async submit(
    user: AuthUser,
    examId: string,
    input: PracticeSubmitInput,
  ): Promise<PracticeRoundDto> {
    const exam = await this.unlock(user, examId);
    const scored = exam.questions.filter((q) => q.type === 'SINGLE' || q.type === 'MULTI');
    if (scored.length === 0) {
      throw new ConflictException('This set has no choice questions to score');
    }
    const number = new Map(exam.questions.map((q, i) => [q.id, i + 1]));
    const awarded: number[] = [];
    const results: PracticeRoundDto['results'] = [];
    let answered = 0;
    for (const q of scored) {
      const selected = input.answers[q.id] ?? [];
      if (selected.length > 0) answered++;
      const g = gradeChoice(
        {
          type: q.type as 'SINGLE' | 'MULTI',
          correctOptions: q.correctOptions,
          marks: q.marks,
          negativeMarks: q.negativeMarks,
          partialCredit: q.partialCredit,
        },
        selected,
      );
      awarded.push(g.marks);
      results.push({
        questionId: q.id,
        number: number.get(q.id) ?? 0,
        outcome: g.outcome,
        marks: g.marks,
      });
    }
    const total = summarize({
      awarded,
      maxScore: scored.reduce((s, q) => s + q.marks, 0),
      passPercent: exam.passPercent,
    });
    const row = await this.prisma.practiceRound.create({
      data: {
        studentId: user.id,
        examId,
        score: total.score,
        maxScore: total.maxScore,
        percent: total.percent,
        answered,
        scoredCount: scored.length,
        results,
      },
    });
    return this.toRound(row);
  }

  async history(user: AuthUser, examId: string): Promise<PracticeRoundDto[]> {
    await this.unlock(user, examId);
    const rows = await this.prisma.practiceRound.findMany({
      where: { studentId: user.id, examId },
      orderBy: { createdAt: 'desc' },
      take: PRACTICE.HISTORY_LIMIT,
    });
    return rows.map((r) => this.toRound(r));
  }

  private toRound(r: {
    id: string;
    score: number;
    maxScore: number;
    percent: number;
    answered: number;
    scoredCount: number;
    createdAt: Date;
    results: unknown;
  }): PracticeRoundDto {
    return {
      id: r.id,
      score: r.score,
      maxScore: r.maxScore,
      percent: r.percent,
      answered: r.answered,
      scoredCount: r.scoredCount,
      createdAt: r.createdAt.toISOString(),
      results: r.results as PracticeRoundDto['results'],
    };
  }
}

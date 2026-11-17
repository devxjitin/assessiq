import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Exam, Prisma, Question } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  toStudentCoding,
  type CodingSpec,
  type CreateExamInput,
  type ExamDetailDto,
  type ExamPreviewDto,
  type ExamQuestionDto,
  type ExamSummaryDto,
  type ImportQuestionsInput,
  type QuestionInput,
  type UpdateExamInput,
} from '@assessiq/shared';
import { parseQuestionsTxt, type ParsedQuestion } from '@assessiq/question-parser';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE, Storage } from '../storage/storage.service';

const LOGO_MAX_BYTES = 512 * 1024;

/** Detects PNG/JPEG from the file's first bytes; the client-supplied type is not trusted. */
function sniffImage(buf: Buffer): { type: string; ext: string } | null {
  if (
    buf.length > 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { type: 'image/png', ext: 'png' };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: 'image/jpeg', ext: 'jpg' };
  }
  return null;
}

type ExamWithQuestions = Exam & { questions: Question[] };

@Injectable()
export class ExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  // ------------------------------------------------------------------ exams

  async create(user: AuthUser, input: CreateExamInput): Promise<ExamDetailDto> {
    const exam = await this.prisma.exam.create({
      data: {
        examinerId: user.id,
        title: input.title,
        description: input.description ?? null,
        instructions: input.instructions ?? null,
        durationMinutes: input.durationMinutes,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        passPercent: input.passPercent,
        shuffleQuestions: input.shuffleQuestions,
        shuffleOptions: input.shuffleOptions,
        maxStudents: input.maxStudents,
      },
      include: { questions: true },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'exam.create',
      entity: 'Exam',
      entityId: exam.id,
    });
    return this.toDetail(exam);
  }

  async list(user: AuthUser): Promise<ExamSummaryDto[]> {
    const exams = await this.prisma.exam.findMany({
      where: { examinerId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { questions: { select: { marks: true } } },
    });
    return exams.map((e) => this.toSummary(e, e.questions));
  }

  async get(user: AuthUser, examId: string): Promise<ExamDetailDto> {
    return this.toDetail(await this.findOwned(user, examId));
  }

  async update(user: AuthUser, examId: string, input: UpdateExamInput): Promise<ExamDetailDto> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);

    // The window rule also has to hold against values that were not part of this request.
    const startsAt =
      input.startsAt === undefined
        ? exam.startsAt
        : input.startsAt
          ? new Date(input.startsAt)
          : null;
    const endsAt =
      input.endsAt === undefined ? exam.endsAt : input.endsAt ? new Date(input.endsAt) : null;
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: { endsAt: ['The end time must be after the start time'] },
      });
    }

    const updated = await this.prisma.exam.update({
      where: { id: examId },
      data: {
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        durationMinutes: input.durationMinutes,
        startsAt: input.startsAt === undefined ? undefined : startsAt,
        endsAt: input.endsAt === undefined ? undefined : endsAt,
        passPercent: input.passPercent,
        shuffleQuestions: input.shuffleQuestions,
        shuffleOptions: input.shuffleOptions,
        maxStudents: input.maxStudents,
      },
      include: { questions: { orderBy: { position: 'asc' } } },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'exam.update',
      entity: 'Exam',
      entityId: examId,
    });
    return this.toDetail(updated);
  }

  async remove(user: AuthUser, examId: string): Promise<void> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    await this.prisma.exam.delete({ where: { id: examId } });
    if (exam.logoKey) await this.storage.delete(exam.logoKey);
    await this.audit.log({
      actorId: user.id,
      action: 'exam.delete',
      entity: 'Exam',
      entityId: examId,
    });
  }

  /** The exam exactly as a student will see it: no answers, explanations or rubrics. */
  async preview(user: AuthUser, examId: string): Promise<ExamPreviewDto> {
    const exam = await this.findOwned(user, examId);
    return {
      id: exam.id,
      title: exam.title,
      description: exam.description,
      instructions: exam.instructions,
      durationMinutes: exam.durationMinutes,
      totalMarks: this.totalMarks(exam.questions),
      passPercent: exam.passPercent,
      questions: exam.questions.map((q) => {
        const {
          correctOptions: _c,
          explanation: _e,
          rubric: _r,
          coding,
          ...visible
        } = this.toQuestion(q);
        return { ...visible, coding: coding ? toStudentCoding(coding) : null };
      }),
    };
  }

  // -------------------------------------------------------------- questions

  async addQuestion(
    user: AuthUser,
    examId: string,
    input: QuestionInput,
  ): Promise<ExamQuestionDto> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    this.assertRoom(exam.questions.length, 1);
    const created = await this.prisma.question.create({
      data: { examId, position: exam.questions.length + 1, ...this.questionData(input) },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'question.create',
      entity: 'Question',
      entityId: created.id,
    });
    return this.toQuestion(created);
  }

  async updateQuestion(
    user: AuthUser,
    examId: string,
    questionId: string,
    input: QuestionInput,
  ): Promise<ExamQuestionDto> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    this.requireQuestion(exam, questionId);
    const updated = await this.prisma.question.update({
      where: { id: questionId },
      data: this.questionData(input),
    });
    await this.audit.log({
      actorId: user.id,
      action: 'question.update',
      entity: 'Question',
      entityId: questionId,
    });
    return this.toQuestion(updated);
  }

  async removeQuestion(user: AuthUser, examId: string, questionId: string): Promise<void> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    this.requireQuestion(exam, questionId);
    await this.prisma.$transaction([
      this.prisma.question.delete({ where: { id: questionId } }),
      ...exam.questions
        .filter((q) => q.id !== questionId)
        .map((q, i) =>
          this.prisma.question.update({ where: { id: q.id }, data: { position: i + 1 } }),
        ),
    ]);
    await this.audit.log({
      actorId: user.id,
      action: 'question.delete',
      entity: 'Question',
      entityId: questionId,
    });
  }

  async reorder(user: AuthUser, examId: string, questionIds: string[]): Promise<ExamQuestionDto[]> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    const existing = new Set(exam.questions.map((q) => q.id));
    const supplied = new Set(questionIds);
    if (
      questionIds.length !== exam.questions.length ||
      supplied.size !== questionIds.length ||
      questionIds.some((id) => !existing.has(id))
    ) {
      throw new BadRequestException(
        'The list must contain every question of this exam exactly once',
      );
    }
    await this.prisma.$transaction(
      questionIds.map((id, i) =>
        this.prisma.question.update({ where: { id }, data: { position: i + 1 } }),
      ),
    );
    const fresh = await this.findOwned(user, examId);
    return fresh.questions.map((q) => this.toQuestion(q));
  }

  /** Parses pasted question text. With `commit` false it only reports what would be imported. */
  async importQuestions(user: AuthUser, examId: string, input: ImportQuestionsInput) {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    const parsed: ParsedQuestion[] = parseQuestionsTxt(input.text, {
      defaultMarks: input.defaultMarks,
      defaultNegativeMarks: input.defaultNegativeMarks,
    });
    if (parsed.length === 0) {
      throw new BadRequestException(
        'No questions could be read from the text. Check the format guide.',
      );
    }
    const room = LIMITS.MAX_QUESTIONS_PER_EXAM - exam.questions.length;
    if (!input.commit) {
      return {
        committed: false,
        found: parsed.length,
        importable: Math.min(parsed.length, room),
        questions: parsed,
      };
    }
    this.assertRoom(exam.questions.length, parsed.length);
    await this.prisma.question.createMany({
      data: parsed.map((q, i) => ({
        examId,
        position: exam.questions.length + i + 1,
        type: q.type,
        body: q.body,
        options: q.options,
        correctOptions: q.correctOptions,
        marks: q.marks,
        negativeMarks: Math.min(q.negativeMarks, q.marks),
        explanation: q.explanation || null,
      })),
    });
    await this.audit.log({
      actorId: user.id,
      action: 'question.import',
      entity: 'Exam',
      entityId: examId,
      meta: { count: parsed.length },
    });
    return { committed: true, found: parsed.length, importable: parsed.length, questions: parsed };
  }

  // ------------------------------------------------------------------- logo

  async setLogo(
    user: AuthUser,
    examId: string,
    file: Buffer | undefined,
  ): Promise<{ hasLogo: true }> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    if (!file || file.length === 0) throw new BadRequestException('Choose an image file');
    if (file.length > LOGO_MAX_BYTES)
      throw new BadRequestException('The logo must be 512 KB or smaller');
    const image = sniffImage(file);
    if (!image) throw new BadRequestException('The logo must be a PNG or JPEG image');

    const key = `logos/exams/${examId}/${randomUUID()}.${image.ext}`;
    await this.storage.put(key, file, image.type);
    await this.prisma.exam.update({ where: { id: examId }, data: { logoKey: key } });
    if (exam.logoKey) await this.storage.delete(exam.logoKey);
    await this.audit.log({
      actorId: user.id,
      action: 'exam.logo.set',
      entity: 'Exam',
      entityId: examId,
    });
    return { hasLogo: true };
  }

  async getLogo(user: AuthUser, examId: string) {
    const exam = await this.findOwned(user, examId);
    const file = exam.logoKey ? await this.storage.get(exam.logoKey) : null;
    if (!file) throw new NotFoundException('No logo');
    return file;
  }

  async removeLogo(user: AuthUser, examId: string): Promise<void> {
    const exam = await this.findOwned(user, examId);
    this.assertDraft(exam);
    if (!exam.logoKey) return;
    await this.prisma.exam.update({ where: { id: examId }, data: { logoKey: null } });
    await this.storage.delete(exam.logoKey);
    await this.audit.log({
      actorId: user.id,
      action: 'exam.logo.remove',
      entity: 'Exam',
      entityId: examId,
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Other trainers' exams look like they do not exist. */
  private async findOwned(user: AuthUser, examId: string): Promise<ExamWithQuestions> {
    const exam = /^[0-9a-f-]{36}$/i.test(examId)
      ? await this.prisma.exam.findFirst({
          where: { id: examId, examinerId: user.id },
          include: { questions: { orderBy: { position: 'asc' } } },
        })
      : null;
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  private assertDraft(exam: Exam): void {
    if (exam.status !== 'DRAFT') {
      throw new ConflictException('This exam is no longer a draft and cannot be changed');
    }
  }

  private assertRoom(current: number, adding: number): void {
    if (current + adding > LIMITS.MAX_QUESTIONS_PER_EXAM) {
      throw new BadRequestException(
        `An exam can have at most ${LIMITS.MAX_QUESTIONS_PER_EXAM} questions`,
      );
    }
  }

  private requireQuestion(exam: ExamWithQuestions, questionId: string): Question {
    const q = exam.questions.find((x) => x.id === questionId);
    if (!q) throw new NotFoundException('Question not found');
    return q;
  }

  private questionData(
    input: QuestionInput,
  ): Omit<Prisma.QuestionUncheckedCreateInput, 'examId' | 'position'> {
    const base = {
      type: input.type,
      body: input.body,
      marks: input.marks,
      negativeMarks: input.negativeMarks,
      explanation: input.explanation ?? null,
    };
    if (input.type === 'SUBJECTIVE') {
      return { ...base, options: [], correctOptions: [], rubric: input.rubric ?? null };
    }
    if (input.type === 'CODING') {
      const coding: CodingSpec = {
        ...input.coding,
        testCases: input.coding.testCases.map((t) => ({ ...t, id: randomUUID() })),
      };
      return {
        ...base,
        options: [],
        correctOptions: [],
        rubric: null,
        coding: coding as unknown as Prisma.InputJsonValue,
      };
    }
    return {
      ...base,
      options: input.options,
      correctOptions: [...input.correctOptions].sort((a, b) => a - b),
      partialCredit: input.type === 'MULTI' ? input.partialCredit : false,
      rubric: null,
    };
  }

  private totalMarks(questions: { marks: number }[]): number {
    return Math.round(questions.reduce((sum, q) => sum + q.marks, 0) * 100) / 100;
  }

  private toQuestion(q: Question): ExamQuestionDto {
    return {
      id: q.id,
      position: q.position,
      type: q.type as ExamQuestionDto['type'],
      body: q.body,
      options: q.options,
      correctOptions: q.correctOptions,
      marks: q.marks,
      negativeMarks: q.negativeMarks,
      partialCredit: q.partialCredit,
      coding: (q.coding as unknown as CodingSpec | null) ?? null,
      explanation: q.explanation,
      rubric: q.rubric,
    };
  }

  private toSummary(exam: Exam, questions: { marks: number }[]): ExamSummaryDto {
    return {
      id: exam.id,
      title: exam.title,
      status: exam.status,
      durationMinutes: exam.durationMinutes,
      startsAt: exam.startsAt?.toISOString() ?? null,
      endsAt: exam.endsAt?.toISOString() ?? null,
      questionCount: questions.length,
      totalMarks: this.totalMarks(questions),
      createdAt: exam.createdAt.toISOString(),
      updatedAt: exam.updatedAt.toISOString(),
    };
  }

  private toDetail(exam: ExamWithQuestions): ExamDetailDto {
    return {
      ...this.toSummary(exam, exam.questions),
      description: exam.description,
      instructions: exam.instructions,
      passPercent: exam.passPercent,
      shuffleQuestions: exam.shuffleQuestions,
      shuffleOptions: exam.shuffleOptions,
      maxStudents: exam.maxStudents,
      hasLogo: Boolean(exam.logoKey),
      code: exam.code,
      publishedAt: exam.publishedAt?.toISOString() ?? null,
      questions: exam.questions.map((q) => this.toQuestion(q)),
    };
  }
}

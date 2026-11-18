import { z } from 'zod';
import { codingSpecInputSchema, type CodingSpec } from './coding';
import type { StudentCodingDto } from './attempt';
import { LIMITS } from './constants';

/** Settings a trainer controls on a draft exam. */
const examSettings = {
  title: z
    .string({ message: 'Enter an exam title' })
    .trim()
    .min(3, 'The title needs at least 3 characters')
    .max(150, 'The title can be at most 150 characters'),
  description: z
    .string()
    .trim()
    .max(2000, 'Keep the description under 2000 characters')
    .optional()
    .nullable(),
  instructions: z
    .string()
    .trim()
    .max(4000, 'Keep the instructions under 4000 characters')
    .optional()
    .nullable(),
  durationMinutes: z
    .number({ message: 'Enter the duration in minutes' })
    .int('Duration must be a whole number of minutes')
    .min(5, 'Duration must be at least 5 minutes')
    .max(
      LIMITS.MAX_EXAM_DURATION_MINUTES,
      `Duration can be at most ${LIMITS.MAX_EXAM_DURATION_MINUTES} minutes`,
    ),
  // The exam window. Both optional while drafting; required to publish (Sprint 3).
  startsAt: z
    .string()
    .datetime({ message: 'Enter a valid opening date and time' })
    .optional()
    .nullable(),
  endsAt: z
    .string()
    .datetime({ message: 'Enter a valid closing date and time' })
    .optional()
    .nullable(),
  passPercent: z
    .number({ message: 'Enter a pass mark between 0 and 100' })
    .min(0, 'Pass mark cannot be below 0%')
    .max(100, 'Pass mark cannot be above 100%'),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
};

const windowIsValid = (v: { startsAt?: string | null; endsAt?: string | null }) =>
  !v.startsAt || !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt);
const windowMessage = { message: 'The end time must be after the start time', path: ['endsAt'] };

export const createExamSchema = z
  .object({
    ...examSettings,
    description: examSettings.description,
    durationMinutes: examSettings.durationMinutes.default(60),
    passPercent: examSettings.passPercent.default(40),
    shuffleQuestions: examSettings.shuffleQuestions.default(true),
    shuffleOptions: examSettings.shuffleOptions.default(true),
    /** Decided once, when the exam is created. Off = no certificate tab, no certificates. */
    certificatesEnabled: z.boolean().default(true),
  })
  .refine(windowIsValid, windowMessage);
export type CreateExamInput = z.infer<typeof createExamSchema>;

export const updateExamSchema = z
  .object(examSettings)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine(windowIsValid, windowMessage);
export type UpdateExamInput = z.infer<typeof updateExamSchema>;

// ---------------------------------------------------------------- questions

const marks = z.number().min(0).max(100);
const optionText = z.string().trim().min(1).max(1000);

const questionBase = {
  body: z.string().trim().min(1).max(5000),
  marks: marks.default(4),
  negativeMarks: marks.default(0),
  explanation: z.string().trim().max(3000).optional().nullable(),
};

const choiceQuestion = {
  ...questionBase,
  // Multiple-answer only: share the marks when some (but not all) correct options are picked.
  partialCredit: z.boolean().default(false),
  options: z.array(optionText).min(2).max(6),
  correctOptions: z.array(z.number().int().min(0).max(5)).min(1),
};

function checkChoice(
  v: { type: string; options: string[]; correctOptions: number[] },
  ctx: z.RefinementCtx,
) {
  const unique = new Set(v.correctOptions);
  if (unique.size !== v.correctOptions.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['correctOptions'],
      message: 'Duplicate correct options',
    });
  }
  if (v.correctOptions.some((i) => i >= v.options.length)) {
    ctx.addIssue({
      code: 'custom',
      path: ['correctOptions'],
      message: 'A correct option does not exist',
    });
  }
  if (v.type === 'SINGLE' && v.correctOptions.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['correctOptions'],
      message: 'A single-answer question needs exactly one correct option',
    });
  }
  if (v.type === 'MULTI' && v.correctOptions.length < 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['correctOptions'],
      message: 'A multiple-answer question needs at least two correct options',
    });
  }
}

export const questionInputSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('SINGLE'), ...choiceQuestion }),
    z.object({ type: z.literal('MULTI'), ...choiceQuestion }),
    z.object({
      type: z.literal('CODING'),
      ...questionBase,
      coding: codingSpecInputSchema,
    }),
    z.object({
      type: z.literal('SUBJECTIVE'),
      ...questionBase,
      // Guidance for whoever marks the answer.
      rubric: z.string().trim().max(3000).optional().nullable(),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.type === 'SINGLE' || v.type === 'MULTI') checkChoice(v, ctx);
    if (v.negativeMarks > v.marks) {
      ctx.addIssue({
        code: 'custom',
        path: ['negativeMarks'],
        message: 'Negative marks cannot exceed the marks for a correct answer',
      });
    }
  });
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const reorderQuestionsSchema = z.object({
  questionIds: z.array(z.string().uuid()).min(1).max(LIMITS.MAX_QUESTIONS_PER_EXAM),
});
export type ReorderQuestionsInput = z.infer<typeof reorderQuestionsSchema>;

export const importQuestionsSchema = z.object({
  text: z.string().min(1).max(500_000),
  defaultMarks: marks.default(4),
  defaultNegativeMarks: marks.default(0),
  // false = just parse and show what would be imported.
  commit: z.boolean().default(false),
});
export type ImportQuestionsInput = z.infer<typeof importQuestionsSchema>;

// ---------------------------------------------------------------- responses

export interface ExamQuestionDto {
  id: string;
  position: number;
  type: 'SINGLE' | 'MULTI' | 'SUBJECTIVE' | 'CODING';
  body: string;
  options: string[];
  correctOptions: number[];
  marks: number;
  negativeMarks: number;
  partialCredit: boolean;
  /** Coding questions only. */
  coding: CodingSpec | null;
  explanation: string | null;
  rubric: string | null;
}

export interface ExamSummaryDto {
  id: string;
  title: string;
  status: string;
  durationMinutes: number;
  startsAt: string | null;
  endsAt: string | null;
  questionCount: number;
  totalMarks: number;
  /** Students who joined this exam (set on the trainer's exam list). */
  joinedCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExamDetailDto extends ExamSummaryDto {
  description: string | null;
  instructions: string | null;
  passPercent: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  certificatesEnabled: boolean;
  hasLogo: boolean;
  /** Share code; set once the creation fee is paid. */
  code: string | null;
  publishedAt: string | null;
  questions: ExamQuestionDto[];
}

/** What a student sees: no correct answers, no explanations, no rubric. */
export type PreviewQuestionDto = Omit<
  ExamQuestionDto,
  'correctOptions' | 'explanation' | 'rubric' | 'coding'
> & { coding: StudentCodingDto | null };

export interface ExamPreviewDto {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  durationMinutes: number;
  totalMarks: number;
  passPercent: number;
  questions: PreviewQuestionDto[];
}

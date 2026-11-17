import { z } from 'zod';
import { CODE_LANGUAGE_KEYS, type CodeLanguage } from './coding';
import type { StudentCodingDto } from './attempt';

/** Practice never touches official scores; it has its own limits. */
export const PRACTICE = {
  /** A student can ask for feedback on one question this often. */
  CHECK_COOLDOWN_MS: 3000,
  /** Attempts kept per student and exam; older ones are dropped from the history list. */
  HISTORY_LIMIT: 50,
} as const;

/** One question, asking for instant feedback. Send the answer that matches the question type. */
export const practiceCheckSchema = z.object({
  selected: z.array(z.number().int().min(0).max(5)).max(6).optional(),
  text: z.string().max(50_000).optional(),
  language: z.enum(CODE_LANGUAGE_KEYS).optional(),
});
export type PracticeCheckInput = z.infer<typeof practiceCheckSchema>;

/** A whole practice round: the choice answers per question id. */
export const practiceSubmitSchema = z.object({
  answers: z.record(z.string().uuid(), z.array(z.number().int().min(0).max(5)).max(6)),
});
export type PracticeSubmitInput = z.infer<typeof practiceSubmitSchema>;

// ------------------------------------------------------------------------- DTOs

export interface PracticeSummaryDto {
  examId: string;
  title: string;
  trainerName: string;
  questionCount: number;
  /** Choice questions are scored; the rest give feedback only. */
  scoredCount: number;
  rounds: number;
  bestPercent: number | null;
  lastRoundAt: string | null;
}

export interface PracticeQuestionDto {
  id: string;
  number: number;
  type: 'SINGLE' | 'MULTI' | 'SUBJECTIVE' | 'CODING';
  body: string;
  marks: number;
  options: string[];
  coding?: StudentCodingDto;
}

export interface PracticeSetDto {
  examId: string;
  title: string;
  questions: PracticeQuestionDto[];
}

export interface PracticeCodeTest {
  /** Sample cases show everything; hidden ones only pass or fail. */
  hidden: boolean;
  passed: boolean;
  status: string;
  input?: string;
  expectedOutput?: string;
  actualOutput?: string;
  message?: string;
  timeMs: number | null;
}

export interface PracticeFeedbackDto {
  questionId: string;
  type: 'SINGLE' | 'MULTI' | 'SUBJECTIVE' | 'CODING';
  /** Null for written answers, which cannot be marked automatically. */
  correct: boolean | null;
  marks: number | null;
  maxMarks: number;
  correctOptions: number[];
  explanation: string | null;
  /** Written answers: what a good answer covers. */
  guidance: string | null;
  tests?: PracticeCodeTest[];
}

export interface PracticeRoundDto {
  id: string;
  score: number;
  maxScore: number;
  percent: number;
  answered: number;
  scoredCount: number;
  createdAt: string;
  /** Per scored question, how this round went. */
  results: { questionId: string; number: number; outcome: string; marks: number }[];
}

export type PracticeLanguage = CodeLanguage;

import { z } from 'zod';
import type { StudentCodingDto } from './attempt';
import { round2 } from './grading';

/** Languages students can use. `judge0Id` is the language id in Judge0 CE 1.13. */
export const CODE_LANGUAGES = {
  python: { label: 'Python 3', judge0Id: 71, fileHint: 'main.py' },
  c: { label: 'C (GCC)', judge0Id: 50, fileHint: 'main.c' },
  cpp: { label: 'C++ (GCC)', judge0Id: 54, fileHint: 'main.cpp' },
  java: { label: 'Java', judge0Id: 62, fileHint: 'Main.java' },
  javascript: { label: 'JavaScript (Node.js)', judge0Id: 63, fileHint: 'main.js' },
} as const;
export type CodeLanguage = keyof typeof CODE_LANGUAGES;
export const CODE_LANGUAGE_KEYS = Object.keys(CODE_LANGUAGES) as [CodeLanguage, ...CodeLanguage[]];

export const CODING_LIMITS = {
  MAX_TEST_CASES: 20,
  MAX_IO_CHARS: 10_000,
  MAX_SOURCE_CHARS: 50_000,
  MIN_TIME_MS: 500,
  MAX_TIME_MS: 10_000,
  MIN_MEMORY_MB: 32,
  MAX_MEMORY_MB: 512,
  /** Runs on sample cases a student can do per question during an exam. */
  MAX_RUNS_PER_QUESTION: 40,
  /** Minimum gap between two runs of the same question. */
  RUN_COOLDOWN_MS: 3000,
} as const;

const io = z.string().max(CODING_LIMITS.MAX_IO_CHARS);

export const testCaseInputSchema = z.object({
  input: io.default(''),
  expectedOutput: io.refine((v) => v.trim().length > 0, 'Expected output is required'),
  /** Hidden cases are used for grading only; students never see their input or output. */
  hidden: z.boolean().default(false),
  weight: z.number().min(1).max(100).default(1),
});
export type TestCaseInput = z.infer<typeof testCaseInputSchema>;

export const codingSpecInputSchema = z
  .object({
    languages: z.array(z.enum(CODE_LANGUAGE_KEYS)).min(1).max(CODE_LANGUAGE_KEYS.length),
    starterCode: z
      .record(z.enum(CODE_LANGUAGE_KEYS), z.string().max(CODING_LIMITS.MAX_SOURCE_CHARS))
      .default({}),
    timeLimitMs: z
      .number()
      .int()
      .min(CODING_LIMITS.MIN_TIME_MS)
      .max(CODING_LIMITS.MAX_TIME_MS)
      .default(2000),
    memoryMb: z
      .number()
      .int()
      .min(CODING_LIMITS.MIN_MEMORY_MB)
      .max(CODING_LIMITS.MAX_MEMORY_MB)
      .default(256),
    testCases: z.array(testCaseInputSchema).min(1).max(CODING_LIMITS.MAX_TEST_CASES),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.languages).size !== v.languages.length) {
      ctx.addIssue({ code: 'custom', path: ['languages'], message: 'Duplicate language' });
    }
    if (!v.testCases.some((t) => !t.hidden)) {
      ctx.addIssue({
        code: 'custom',
        path: ['testCases'],
        message: 'Add at least one sample (visible) test case so students can try their code',
      });
    }
  });
export type CodingSpecInput = z.infer<typeof codingSpecInputSchema>;

/** Stored form: test cases get ids so results can refer to them. */
export interface CodingSpec {
  languages: CodeLanguage[];
  starterCode: Partial<Record<CodeLanguage, string>>;
  timeLimitMs: number;
  memoryMb: number;
  testCases: (TestCaseInput & { id: string })[];
}

export const runCodeSchema = z.object({
  language: z.enum(CODE_LANGUAGE_KEYS),
  source: z.string().max(CODING_LIMITS.MAX_SOURCE_CHARS),
});
export type RunCodeInput = z.infer<typeof runCodeSchema>;

// ---------------------------------------------------------------- comparing

/** Output matching ignores trailing spaces on each line and blank lines at the end. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export const outputsMatch = (expected: string, actual: string): boolean =>
  normalizeOutput(expected) === normalizeOutput(actual);

/** Marks for a coding answer: question marks x (weight of passed cases / total weight). */
export function codingMarks(
  questionMarks: number,
  tests: { weight: number; passed: boolean }[],
): { marks: number; passedWeight: number; totalWeight: number } {
  const totalWeight = tests.reduce((s, t) => s + t.weight, 0);
  const passedWeight = tests.filter((t) => t.passed).reduce((s, t) => s + t.weight, 0);
  return {
    marks: totalWeight > 0 ? round2((questionMarks * passedWeight) / totalWeight) : 0,
    passedWeight,
    totalWeight,
  };
}

// --------------------------------------------------------------------- DTOs

export type TestStatus =
  | 'PASSED'
  | 'WRONG_ANSWER'
  | 'COMPILE_ERROR'
  | 'RUNTIME_ERROR'
  | 'TIME_LIMIT'
  | 'MEMORY_LIMIT'
  | 'ERROR';

/** Result of one sample run in the exam. */
export interface SampleRunResult {
  input: string;
  expectedOutput: string;
  actualOutput: string;
  /** Compiler or runtime message, shortened. */
  message: string;
  status: TestStatus;
  timeMs: number | null;
}

export interface RunResultDto {
  runsLeft: number;
  results: SampleRunResult[];
}

/** Stored per-test outcome of the final grading. Hidden tests carry no input or output. */
export interface GradedTest {
  testId: string;
  hidden: boolean;
  status: TestStatus;
  passed: boolean;
  timeMs: number | null;
}

export interface CodeSubmissionDto {
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'ERROR';
  passedWeight: number;
  totalWeight: number;
  tests: GradedTest[];
}

/** The student-safe view of a coding question: sample cases only, hidden ones just counted. */
export function toStudentCoding(spec: CodingSpec): StudentCodingDto {
  return {
    languages: spec.languages,
    starterCode: spec.starterCode,
    timeLimitMs: spec.timeLimitMs,
    memoryMb: spec.memoryMb,
    samples: spec.testCases
      .filter((t) => !t.hidden)
      .map((t) => ({ input: t.input, expectedOutput: t.expectedOutput })),
    hiddenCount: spec.testCases.filter((t) => t.hidden).length,
  };
}

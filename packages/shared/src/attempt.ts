import { z } from 'zod';

export const startAttemptSchema = z.object({ enrollmentId: z.string().uuid() });
export type StartAttemptInput = z.infer<typeof startAttemptSchema>;

/** Autosave payload. Send only what changed; at least one field is required. */
export const saveAnswerSchema = z
  .object({
    selected: z.array(z.number().int().min(0).max(5)).max(6).optional(),
    text: z.string().max(20_000).optional(),
    flagged: z.boolean().optional(),
  })
  .refine((v) => v.selected !== undefined || v.text !== undefined || v.flagged !== undefined, {
    message: 'Nothing to save',
  });
export type SaveAnswerInput = z.infer<typeof saveAnswerSchema>;

/** Browser-side signals the student's exam page reports. */
export const PROCTOR_EVENTS = [
  'TAB_HIDDEN',
  'WINDOW_BLUR',
  'FULLSCREEN_EXIT',
  'COPY',
  'PASTE',
  'CONTEXT_MENU',
  'DEVTOOLS_KEY',
] as const;
export type ProctorEventType = (typeof PROCTOR_EVENTS)[number];

/** Events that cost a strike. The rest are logged for the trainer only. */
export const STRIKE_EVENTS: readonly ProctorEventType[] = [
  'TAB_HIDDEN',
  'WINDOW_BLUR',
  'FULLSCREEN_EXIT',
];

export const proctorEventSchema = z.object({ type: z.enum(PROCTOR_EVENTS) });
export type ProctorEventInput = z.infer<typeof proctorEventSchema>;

export type JoinState = 'OPEN' | 'NOT_STARTED' | 'ENDED' | 'FULL' | 'ALREADY_ENROLLED';

export interface JoinInfoDto {
  examId: string;
  code: string;
  title: string;
  description: string | null;
  trainerName: string;
  orgName: string | null;
  durationMinutes: number;
  startsAt: string | null;
  endsAt: string | null;
  questionCount: number;
  totalMarks: number;
  feePaise: number;
  state: JoinState;
}

export interface EnrollmentDto {
  enrollmentId: string;
  exam: {
    id: string;
    title: string;
    startsAt: string | null;
    endsAt: string | null;
    durationMinutes: number;
  };
  attempt: { id: string; status: string; deadlineAt: string } | null;
  /** Set once the trainer has published results. */
  result: { score: number; maxScore: number; percent: number; passed: boolean } | null;
  /** The exam window is open and no attempt has ended yet. */
  canStart: boolean;
}

export interface AttemptQuestionDto {
  id: string;
  number: number;
  type: 'SINGLE' | 'MULTI' | 'SUBJECTIVE';
  body: string;
  marks: number;
  negativeMarks: number;
  /** Options in this student's order. `id` is the original index and is what gets saved. */
  options: { id: number; text: string }[];
}

export interface AttemptAnswerDto {
  selected: number[];
  text: string;
  flagged: boolean;
}

export interface AttemptDto {
  id: string;
  status: string;
  endReason: string | null;
  /** Server clock, so the browser can show an accurate countdown. */
  serverTime: string;
  deadlineAt: string;
  strikes: number;
  maxStrikes: number;
  exam: { title: string; instructions: string | null; durationMinutes: number };
  /** Empty once the attempt has ended. */
  questions: AttemptQuestionDto[];
  answers: Record<string, AttemptAnswerDto>;
}

import { z } from 'zod';

/** What an exam is doing right now. Only part of this is stored; the rest follows from the window. */
export type ExamPhase = 'DRAFT' | 'UPCOMING' | 'LIVE' | 'CLOSED' | 'RESULTS' | 'CANCELLED';

export function examPhase(
  exam: { status: string; startsAt: Date | string | null; endsAt: Date | string | null },
  now: Date = new Date(),
): ExamPhase {
  if (exam.status === 'DRAFT') return 'DRAFT';
  if (exam.status === 'CANCELLED') return 'CANCELLED';
  if (exam.status === 'RESULTS_FINAL') return 'RESULTS';
  const t = now.getTime();
  if (exam.endsAt && new Date(exam.endsAt).getTime() <= t) return 'CLOSED';
  if (exam.startsAt && new Date(exam.startsAt).getTime() > t) return 'UPCOMING';
  return 'LIVE';
}

export const extendExamSchema = z.object({ endsAt: z.string().datetime() });
export type ExtendExamInput = z.infer<typeof extendExamSchema>;

export const cancelExamSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  /** Cancel even though some students already started. Their seats are not refunded. */
  force: z.boolean().optional(),
});
export type CancelExamInput = z.infer<typeof cancelExamSchema>;

export interface CancelExamResultDto {
  status: 'CANCELLED';
  refunded: number;
  /** Payments that could not be refunded (already started or gateway trouble), for an admin. */
  notRefunded: { paymentId: string; reason: string }[];
}

export interface CloseExamResultDto {
  closedAt: string;
  /** Students still sitting the exam; they keep their own deadline. */
  stillRunning: number;
}

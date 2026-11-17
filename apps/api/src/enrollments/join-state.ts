import type { JoinState } from '@assessiq/shared';

/** Whether a student can join right now. Pure so the same rule is used when ordering and capturing. */
export function computeJoinState(input: {
  startsAt: Date | null;
  endsAt: Date | null;
  maxStudents: number;
  seatsTaken: number;
  alreadyEnrolled: boolean;
  now?: Date;
}): JoinState {
  const now = input.now ?? new Date();
  if (input.alreadyEnrolled) return 'ALREADY_ENROLLED';
  if (input.endsAt && input.endsAt <= now) return 'ENDED';
  if (input.seatsTaken >= input.maxStudents) return 'FULL';
  // Joining stays open until the exam closes; starting is what the window gates.
  return input.startsAt && input.startsAt > now ? 'NOT_STARTED' : 'OPEN';
}

/** Codes are typed by hand: ignore case, spaces and a missing dash. */
export function normalizeCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.startsWith('NVX') ? `NVX-${c.slice(3)}` : c;
}

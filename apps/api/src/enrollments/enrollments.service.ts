import { Injectable, NotFoundException } from '@nestjs/common';
import { PRICING, type EnrollmentDto, type JoinInfoDto } from '@assessiq/shared';
import type { AuthUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { computeJoinState, normalizeCode } from './join-state';

@Injectable()
export class EnrollmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** What a student sees after typing a code, before paying. */
  async joinInfo(user: AuthUser, rawCode: string): Promise<JoinInfoDto> {
    const exam = await this.prisma.exam.findUnique({
      where: { code: normalizeCode(rawCode) },
      include: {
        questions: { select: { marks: true } },
        examiner: { select: { name: true, examinerProfile: { select: { orgName: true } } } },
        _count: { select: { enrollments: true } },
      },
    });
    if (!exam || exam.status !== 'PUBLISHED') throw new NotFoundException('Exam code not found');
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: user.id } },
    });
    return {
      examId: exam.id,
      code: exam.code!,
      title: exam.title,
      description: exam.description,
      trainerName: exam.examiner.name,
      orgName: exam.examiner.examinerProfile?.orgName ?? null,
      durationMinutes: exam.durationMinutes,
      startsAt: exam.startsAt?.toISOString() ?? null,
      endsAt: exam.endsAt?.toISOString() ?? null,
      questionCount: exam.questions.length,
      totalMarks: Math.round(exam.questions.reduce((s, q) => s + q.marks, 0) * 100) / 100,
      feePaise: PRICING.EXAM_JOIN_PAISE,
      state: computeJoinState({
        startsAt: exam.startsAt,
        endsAt: exam.endsAt,
        maxStudents: exam.maxStudents,
        seatsTaken: exam._count.enrollments,
        alreadyEnrolled: Boolean(enrolled),
      }),
    };
  }

  async mine(user: AuthUser): Promise<EnrollmentDto[]> {
    const rows = await this.prisma.enrollment.findMany({
      where: { studentId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        exam: {
          select: { id: true, title: true, startsAt: true, endsAt: true, durationMinutes: true },
        },
        attempt: { select: { id: true, status: true, deadlineAt: true } },
      },
    });
    const now = new Date();
    return rows.map((r) => {
      const open =
        (!r.exam.startsAt || r.exam.startsAt <= now) && (!r.exam.endsAt || r.exam.endsAt > now);
      const attemptDone = r.attempt && r.attempt.status !== 'IN_PROGRESS';
      const running = r.attempt && r.attempt.status === 'IN_PROGRESS' && r.attempt.deadlineAt > now;
      return {
        enrollmentId: r.id,
        exam: {
          id: r.exam.id,
          title: r.exam.title,
          startsAt: r.exam.startsAt?.toISOString() ?? null,
          endsAt: r.exam.endsAt?.toISOString() ?? null,
          durationMinutes: r.exam.durationMinutes,
        },
        attempt: r.attempt
          ? {
              id: r.attempt.id,
              status: r.attempt.status,
              deadlineAt: r.attempt.deadlineAt.toISOString(),
            }
          : null,
        canStart: !attemptDone && (Boolean(running) || open),
      };
    });
  }
}

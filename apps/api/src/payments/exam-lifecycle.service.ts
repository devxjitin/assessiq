import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CancelExamResultDto, CloseExamResultDto } from '@assessiq/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from './payments.service';

const UUID = /^[0-9a-f-]{36}$/i;

/** Changes to an exam after it is published: extend, close early, cancel (and admin suspend). */
@Injectable()
export class ExamLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {}

  private async load(examId: string, ownerId?: string) {
    const exam = UUID.test(examId)
      ? await this.prisma.exam.findFirst({
          where: { id: examId, ...(ownerId ? { examinerId: ownerId } : {}) },
        })
      : null;
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  /** Moves the closing time later. Running attempts keep their own deadlines. */
  async extend(user: AuthUser, examId: string, endsAt: Date) {
    const exam = await this.load(examId, user.id);
    if (exam.status !== 'PUBLISHED')
      throw new ConflictException('This exam is not open for changes');
    if (!exam.endsAt || endsAt <= exam.endsAt) {
      throw new ConflictException('The new closing time must be later than the current one');
    }
    if (endsAt <= new Date())
      throw new ConflictException('The new closing time must be in the future');
    await this.prisma.exam.update({ where: { id: exam.id }, data: { endsAt } });
    await this.audit.log({
      actorId: user.id,
      action: 'exam.extend',
      entity: 'Exam',
      entityId: exam.id,
      meta: { from: exam.endsAt.toISOString(), to: endsAt.toISOString() },
    });
    return { endsAt: endsAt.toISOString() };
  }

  /** Stops new students from starting. Students already sitting the exam finish normally. */
  async close(user: AuthUser, examId: string): Promise<CloseExamResultDto> {
    const exam = await this.load(examId, user.id);
    if (exam.status !== 'PUBLISHED')
      throw new ConflictException('This exam is not open for changes');
    const now = new Date();
    if (exam.endsAt && exam.endsAt <= now)
      throw new ConflictException('This exam is already closed');
    await this.prisma.exam.update({ where: { id: exam.id }, data: { endsAt: now } });
    const stillRunning = await this.prisma.attempt.count({
      where: { examId: exam.id, status: 'IN_PROGRESS' },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'exam.close',
      entity: 'Exam',
      entityId: exam.id,
      meta: { stillRunning },
    });
    return { closedAt: now.toISOString(), stillRunning };
  }

  /** Cancels the exam and refunds every student who has not started. The creation fee stays. */
  async cancel(
    actor: AuthUser,
    examId: string,
    input: { reason: string; force?: boolean },
    asAdmin = false,
  ): Promise<CancelExamResultDto> {
    const exam = await this.load(examId, asAdmin ? undefined : actor.id);
    if (exam.status !== 'PUBLISHED') {
      throw new ConflictException('Only a published exam can be cancelled');
    }
    const started = await this.prisma.attempt.count({ where: { examId: exam.id } });
    if (started > 0 && !input.force && !asAdmin) {
      throw new ConflictException(
        started +
          ' student(s) have already started this exam. Close it instead, or cancel with force.',
      );
    }

    // Claim first, so two cancels cannot both refund.
    const claimed = await this.prisma.exam.updateMany({
      where: { id: exam.id, status: 'PUBLISHED' },
      data: { status: 'CANCELLED' },
    });
    if (claimed.count === 0) throw new ConflictException('This exam was already changed');

    const payments = await this.prisma.payment.findMany({
      where: {
        examId: exam.id,
        status: 'CAPTURED',
        purpose: { in: ['EXAM_JOIN', 'SEAT_PACK'] },
      },
      select: { id: true },
    });
    let refunded = 0;
    const notRefunded: CancelExamResultDto['notRefunded'] = [];
    for (const p of payments) {
      try {
        await this.payments.refund(actor, p.id, 'Exam cancelled: ' + input.reason);
        refunded++;
      } catch (err) {
        notRefunded.push({ paymentId: p.id, reason: (err as Error).message });
      }
    }
    await this.audit.log({
      actorId: actor.id,
      action: asAdmin ? 'exam.suspend' : 'exam.cancel',
      entity: 'Exam',
      entityId: exam.id,
      meta: { reason: input.reason, started, refunded, notRefunded: notRefunded.length },
    });
    return { status: 'CANCELLED', refunded, notRefunded };
  }
}

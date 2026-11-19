import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { type SeatDto, type SeatPreviewDto, type SeatsDto } from '@assessiq/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { ENV, Env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';

const UUID = /^[0-9a-f-]{36}$/i;

/** Seats a trainer paid for, and the students who use them to join without paying. */
@Injectable()
export class SeatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private link(token: string) {
    return `${this.env.WEB_ORIGIN.split(',')[0].trim()}/redeem/?token=${encodeURIComponent(token)}`;
  }

  private async owned(user: AuthUser, examId: string) {
    const exam = UUID.test(examId)
      ? await this.prisma.exam.findFirst({ where: { id: examId, examinerId: user.id } })
      : null;
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  // ---------------------------------------------------------------- trainer

  async list(user: AuthUser, examId: string): Promise<SeatsDto> {
    const exam = await this.owned(user, examId);
    const seats = await this.prisma.seat.findMany({
      where: { pack: { examId: exam.id } },
      orderBy: { createdAt: 'asc' },
    });
    const students = await this.prisma.user.findMany({
      where: { id: { in: seats.map((s) => s.redeemedById).filter((x): x is string => !!x) } },
      select: { id: true, name: true },
    });
    const name = new Map(students.map((s) => [s.id, s.name]));
    const dto: SeatDto[] = seats.map((s) => ({
      id: s.id,
      token: s.token,
      email: s.email,
      status: s.redeemedAt ? 'REDEEMED' : s.email ? 'ASSIGNED' : 'AVAILABLE',
      redeemedByName: s.redeemedById ? (name.get(s.redeemedById) ?? null) : null,
      redeemedAt: s.redeemedAt?.toISOString() ?? null,
    }));
    return {
      examId: exam.id,
      bought: seats.length,
      redeemed: dto.filter((s) => s.status === 'REDEEMED').length,
      unused: dto.filter((s) => s.status !== 'REDEEMED').length,
      closed: exam.status !== 'PUBLISHED' || (exam.endsAt !== null && exam.endsAt <= new Date()),
      priceEachPaise: (await this.settings.get()).examJoinPaise,
      seats: dto,
    };
  }

  /** Reserves free seats for specific email addresses and emails each student their link. */
  async assign(user: AuthUser, examId: string, emails: string[]): Promise<SeatsDto> {
    const exam = await this.owned(user, examId);
    const unique = [...new Set(emails)];
    const sent: { email: string; token: string }[] = [];

    await this.prisma.$transaction(async (tx) => {
      const taken = await tx.seat.findMany({
        where: { pack: { examId: exam.id }, email: { in: unique } },
        select: { email: true },
      });
      const joined = await tx.enrollment.findMany({
        where: { examId: exam.id, student: { email: { in: unique, mode: 'insensitive' } } },
        select: { student: { select: { email: true } } },
      });
      const clash = [
        ...taken.map((t) => t.email!),
        ...joined.map((j) => j.student.email.toLowerCase()),
      ];
      if (clash.length) {
        throw new ConflictException(
          `These students already have a seat or have joined: ${[...new Set(clash)].join(', ')}`,
        );
      }
      const free = await tx.seat.findMany({
        where: { pack: { examId: exam.id }, email: null, redeemedAt: null },
        orderBy: { createdAt: 'asc' },
        take: unique.length,
      });
      if (free.length < unique.length) {
        throw new ConflictException(
          `You have ${free.length} unassigned seat(s) but listed ${unique.length} students. Buy more seats first.`,
        );
      }
      for (const [i, email] of unique.entries()) {
        await tx.seat.update({ where: { id: free[i].id }, data: { email } });
        sent.push({ email, token: free[i].token });
      }
    });

    const trainer = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    for (const s of sent) {
      await this.mail.sendSeatInvite(s.email, {
        examTitle: exam.title,
        trainerName: trainer.name,
        link: this.link(s.token),
      });
    }
    await this.audit.log({
      actorId: user.id,
      action: 'seats.assign',
      entity: 'Exam',
      entityId: exam.id,
      meta: { count: sent.length },
    });
    return this.list(user, examId);
  }

  private async ownedSeat(user: AuthUser, examId: string, seatId: string) {
    const exam = await this.owned(user, examId);
    const seat = UUID.test(seatId)
      ? await this.prisma.seat.findFirst({
          where: { id: seatId, pack: { examId: exam.id } },
        })
      : null;
    if (!seat) throw new NotFoundException('Seat not found');
    if (seat.redeemedAt) throw new ConflictException('This seat is already used');
    return { exam, seat };
  }

  /** Changes who a seat is reserved for (a typo, a different student) and emails the new link. */
  async reassign(user: AuthUser, examId: string, seatId: string, email: string): Promise<SeatsDto> {
    const { exam, seat } = await this.ownedSeat(user, examId, seatId);
    const taken = await this.prisma.seat.findFirst({
      where: { id: { not: seat.id }, pack: { examId: exam.id }, email },
    });
    const joined = await this.prisma.enrollment.findFirst({
      where: { examId: exam.id, student: { email: { equals: email, mode: 'insensitive' } } },
    });
    if (taken || joined) {
      throw new ConflictException('That student already has a seat or has joined');
    }
    // Same token would let the old address use the link, so the seat gets a fresh one.
    await this.prisma.seat.update({
      where: { id: seat.id },
      data: { email, token: randomBytes(20).toString('base64url') },
    });
    const fresh = await this.prisma.seat.findUniqueOrThrow({ where: { id: seat.id } });
    const trainer = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await this.mail.sendSeatInvite(email, {
      examTitle: exam.title,
      trainerName: trainer.name,
      link: this.link(fresh.token),
    });
    await this.audit.log({
      actorId: user.id,
      action: 'seats.reassign',
      entity: 'Seat',
      entityId: seat.id,
      meta: { from: seat.email, to: email },
    });
    return this.list(user, examId);
  }

  /** Frees a reserved seat so it can be given to someone else. The old link stops working. */
  async unassign(user: AuthUser, examId: string, seatId: string): Promise<SeatsDto> {
    const { seat } = await this.ownedSeat(user, examId, seatId);
    await this.prisma.seat.update({
      where: { id: seat.id },
      data: { email: null, token: randomBytes(20).toString('base64url') },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'seats.unassign',
      entity: 'Seat',
      entityId: seat.id,
      meta: { was: seat.email },
    });
    return this.list(user, examId);
  }

  /** Sends the redeem link again to the student a seat is reserved for. */
  async resend(user: AuthUser, examId: string, seatId: string): Promise<{ sent: true }> {
    const { exam, seat } = await this.ownedSeat(user, examId, seatId);
    if (!seat.email) throw new ConflictException('This seat is not reserved for anyone');
    const trainer = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await this.mail.sendSeatInvite(seat.email, {
      examTitle: exam.title,
      trainerName: trainer.name,
      link: this.link(seat.token),
    });
    return { sent: true };
  }

  // ---------------------------------------------------------------- student

  async preview(token: string): Promise<SeatPreviewDto> {
    const seat = await this.prisma.seat.findUnique({
      where: { token },
      include: {
        pack: { include: { exam: { include: { examiner: { select: { name: true } } } } } },
      },
    });
    if (!seat || seat.redeemedAt) throw new NotFoundException('This seat link is not valid');
    const { exam } = seat.pack;
    return {
      examTitle: exam.title,
      trainerName: exam.examiner.name,
      startsAt: exam.startsAt?.toISOString() ?? null,
      endsAt: exam.endsAt?.toISOString() ?? null,
      forEmail: seat.email,
    };
  }

  /** Joins the exam on a sponsored seat, without paying. */
  async redeem(user: AuthUser, token: string): Promise<{ enrollmentId: string; examId: string }> {
    const seat = await this.prisma.seat.findUnique({
      where: { token },
      include: { pack: { include: { exam: true } } },
    });
    if (!seat || seat.redeemedAt) throw new NotFoundException('This seat link is not valid');
    const { exam } = seat.pack;
    if (seat.email && seat.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new ConflictException(
        `This seat is reserved for ${seat.email}. Sign in with that email.`,
      );
    }
    if (exam.status !== 'PUBLISHED') throw new ConflictException('This exam is not available');
    if (exam.endsAt && exam.endsAt <= new Date())
      throw new ConflictException('This exam has ended');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const already = await tx.enrollment.findUnique({
          where: { examId_studentId: { examId: exam.id, studentId: user.id } },
        });
        if (already) throw new ConflictException('You have already joined this exam');
        // Claim first: only one request can turn this seat into an enrollment.
        const claimed = await tx.seat.updateMany({
          where: { id: seat.id, redeemedAt: null },
          data: { redeemedById: user.id, redeemedAt: new Date() },
        });
        if (claimed.count === 0) throw new ConflictException('This seat has just been used');
        const enrollment = await tx.enrollment.create({
          data: { examId: exam.id, studentId: user.id, seatId: seat.id },
        });
        await tx.seat.update({ where: { id: seat.id }, data: { enrollmentId: enrollment.id } });
        return { enrollmentId: enrollment.id, examId: exam.id };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('You have already joined this exam');
      }
      throw err;
    } finally {
      await this.audit.log({
        actorId: user.id,
        action: 'seats.redeem',
        entity: 'Exam',
        entityId: exam.id,
      });
    }
  }
}

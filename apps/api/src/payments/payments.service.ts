import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import {
  PRICING,
  SEAT_LIMITS,
  formatReceiptNo,
  joinFeeLines,
  platformFeeLines,
  reverseLines,
  type AdminPaymentRow,
  type PublishOrderDto,
  type PublishResultDto,
  type VerifyPaymentInput,
} from '@assessiq/shared';
import { computeJoinState, normalizeCode } from '../enrollments/join-state';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { LedgerService } from '../ledger/ledger.service';
import { MailService } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { seatToken } from '../seats/capacity';
import { FakePaymentProvider, PAYMENT_PROVIDER, PaymentProvider } from './provider';

// No 0/O/1/I/L so codes are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateExamCode(): string {
  let tail = '';
  for (let i = 0; i < 6; i++) tail += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `NVX-${tail}`;
}

const UUID = /^[0-9a-f-]{36}$/i;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {
    if (provider.name === 'fake') {
      this.logger.warn(
        'PAYMENT_PROVIDER=fake: payments are simulated. Never use this in production.',
      );
    }
  }

  // ----------------------------------------------------------- create order

  /** Starts (or resumes) the creation-fee payment that publishes a draft exam. */
  async createPublishOrder(user: AuthUser, examId: string): Promise<PublishOrderDto> {
    const exam = UUID.test(examId)
      ? await this.prisma.exam.findFirst({
          where: { id: examId, examinerId: user.id },
          include: { _count: { select: { questions: true } } },
        })
      : null;
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status !== 'DRAFT') throw new ConflictException('This exam is already published');

    const problems: string[] = [];
    if (exam._count.questions < 1) problems.push('Add at least one question.');
    if (!exam.startsAt || !exam.endsAt) {
      problems.push('Set when the exam opens and closes (Settings tab).');
    } else {
      if (exam.endsAt <= new Date()) problems.push('The closing time must be in the future.');
      const windowMinutes = (exam.endsAt.getTime() - exam.startsAt.getTime()) / 60000;
      if (windowMinutes < exam.durationMinutes) {
        problems.push('The open window is shorter than the exam duration.');
      }
    }
    if (problems.length) {
      throw new BadRequestException({
        statusCode: 400,
        message: `Fix this before publishing: ${problems.join(' ')}`,
        problems,
      });
    }

    const fees = await this.settings.get();
    // An unpaid order made at an old price is not reused.
    const existing = await this.prisma.payment.findFirst({
      where: {
        examId,
        purpose: 'EXAM_CREATION',
        status: 'CREATED',
        provider: this.provider.name,
        amountPaise: fees.examCreationPaise,
      },
      orderBy: { createdAt: 'desc' },
    });
    let orderId = existing?.providerOrderId;
    if (!orderId) {
      const order = await this.provider.createOrder({
        amountPaise: fees.examCreationPaise,
        currency: PRICING.CURRENCY,
        receipt: `exam_${exam.id.slice(0, 8)}_${Date.now().toString(36)}`,
      });
      orderId = order.orderId;
      await this.prisma.payment.create({
        data: {
          userId: user.id,
          examId,
          purpose: 'EXAM_CREATION',
          amountPaise: fees.examCreationPaise,
          currency: PRICING.CURRENCY,
          provider: this.provider.name,
          providerOrderId: orderId,
        },
      });
      await this.audit.log({
        actorId: user.id,
        action: 'payment.order',
        entity: 'Exam',
        entityId: examId,
      });
    }
    return {
      provider: this.provider.name,
      orderId,
      amountPaise: fees.examCreationPaise,
      currency: PRICING.CURRENCY,
      keyId: this.provider.publicKeyId,
      description: `Publish exam: ${exam.title}`.slice(0, 250),
    };
  }

  // --------------------------------------------------------------- verify

  /** Called by the browser after Checkout. The signature proves the gateway captured the payment. */
  async verify(user: AuthUser, input: VerifyPaymentInput): Promise<PublishResultDto> {
    const payment = await this.prisma.payment.findUnique({
      where: { providerOrderId: input.orderId },
    });
    if (!payment || payment.userId !== user.id) throw new NotFoundException('Payment not found');
    if (!this.provider.verifyCheckoutSignature(input.orderId, input.paymentId, input.signature)) {
      await this.audit.log({
        actorId: user.id,
        action: 'payment.verify.failed',
        entity: 'Payment',
        entityId: payment.id,
      });
      throw new BadRequestException('Payment verification failed');
    }
    if (payment.status === 'REFUNDED') throw new ConflictException('This payment was refunded');
    const done = await this.capture(input.orderId, input.paymentId, undefined, 'checkout');
    if (!done || done.status !== 'CAPTURED') {
      throw new BadRequestException('Payment could not be confirmed');
    }
    if (done.purpose === 'EXAM_JOIN') {
      const enrollment = await this.prisma.enrollment.findUnique({ where: { paymentId: done.id } });
      if (!enrollment || !done.examId) {
        throw new ConflictException(
          'Your payment was received but a seat could not be reserved. It will be refunded.',
        );
      }
      return {
        exam: { id: done.examId, status: 'PUBLISHED', code: null },
        enrollmentId: enrollment.id,
        receiptNo: formatReceiptNo(done.receiptNo),
      };
    }
    const exam = done.examId
      ? await this.prisma.exam.findUnique({
          where: { id: done.examId },
          select: { id: true, status: true, code: true },
        })
      : null;
    if (!exam) {
      throw new ConflictException('The exam for this payment no longer exists. Contact support.');
    }
    return { exam, receiptNo: formatReceiptNo(done.receiptNo) };
  }

  // -------------------------------------------------------------- webhook

  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventIdHeader: string | undefined,
    body: unknown,
  ): Promise<{ received: true; duplicate?: true }> {
    if (!rawBody || !this.provider.verifyWebhookSignature(rawBody, signature)) {
      await this.audit.log({ action: 'payment.webhook.badsignature' });
      throw new BadRequestException('Invalid signature');
    }
    const info = this.provider.parseWebhook(body, eventIdHeader);
    if (!info.eventId) throw new BadRequestException('Missing event id');

    const seen = await this.prisma.webhookEvent.findUnique({ where: { eventId: info.eventId } });
    if (seen) return { received: true, duplicate: true };

    if (info.type === 'captured' && info.orderId && info.paymentId) {
      await this.capture(info.orderId, info.paymentId, info.amountPaise, 'webhook');
    } else if (info.type === 'failed' && info.orderId) {
      // Only an unpaid order can fail; a captured payment is never downgraded.
      await this.prisma.payment.updateMany({
        where: { providerOrderId: info.orderId, status: 'CREATED' },
        data: { status: 'FAILED', failureReason: info.reason?.slice(0, 300) ?? null },
      });
    }

    // Recorded after processing so a crash mid-way lets the gateway's retry run again.
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: this.provider.name, eventId: info.eventId, type: info.type },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    return { received: true };
  }

  // ---------------------------------------------------------------- fake

  /** Simulates a successful gateway checkout. Only exists for the fake provider. */
  async fakeComplete(user: AuthUser, orderId: string) {
    if (this.provider.name !== 'fake') throw new NotFoundException();
    const payment = await this.prisma.payment.findUnique({ where: { providerOrderId: orderId } });
    if (!payment || payment.userId !== user.id) throw new NotFoundException('Payment not found');
    const paymentId =
      payment.providerPaymentId ?? `fake_pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    return { orderId, paymentId, signature: FakePaymentProvider.sign(orderId, paymentId) };
  }

  // -------------------------------------------------------------- capture

  /**
   * Marks a payment captured and publishes the exam, exactly once. Safe to call repeatedly
   * and from both the browser and the webhook: only the call that flips the status acts.
   */
  private async capture(
    orderId: string,
    paymentId: string,
    amountPaise: number | undefined,
    via: string,
  ) {
    const payment = await this.prisma.payment.findUnique({ where: { providerOrderId: orderId } });
    if (!payment) return null;

    if (amountPaise !== undefined && amountPaise !== payment.amountPaise) {
      await this.audit.log({
        action: 'payment.amount.mismatch',
        entity: 'Payment',
        entityId: payment.id,
        meta: { expected: payment.amountPaise, received: amountPaise, via },
      });
      return payment;
    }

    const published = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: ['CREATED', 'FAILED'] } },
        data: {
          status: 'CAPTURED',
          providerPaymentId: paymentId,
          capturedAt: new Date(),
          failureReason: null,
        },
      });
      if (claimed.count === 0) return null;

      // The money is in; the ledger records who it belongs to, in the same transaction.
      if (payment.purpose === 'EXAM_JOIN') {
        const result = await this.enroll(tx, payment);
        const lines =
          result.enrollment && result.exam
            ? joinFeeLines(
                payment.amountPaise,
                result.exam.examinerId,
                result.exam.id,
                (await this.settings.get()).examinerSharePercent,
              )
            : platformFeeLines(payment.amountPaise, payment.examId, 'NO_SEAT_REFUND_DUE');
        await this.ledger.post(tx, lines, { type: 'CREDIT', paymentId: payment.id });
        return result;
      }
      if (payment.purpose === 'SEAT_PACK') {
        // Sponsored seats: no trainer share, the whole fee is NandiVex's (default Q1).
        await this.ledger.post(tx, platformFeeLines(payment.amountPaise, payment.examId), {
          type: 'CREDIT',
          paymentId: payment.id,
        });
        return this.createSeatPack(tx, payment);
      }
      await this.ledger.post(tx, platformFeeLines(payment.amountPaise, payment.examId), {
        type: 'CREDIT',
        paymentId: payment.id,
      });
      if (!payment.examId) return { exam: null };
      const exam = await tx.exam.findUnique({ where: { id: payment.examId } });
      if (!exam || exam.status !== 'DRAFT') return { exam: exam ?? null };

      let code = generateExamCode();
      for (let i = 0; i < 5 && (await tx.exam.findUnique({ where: { code } })); i++) {
        code = generateExamCode();
      }
      const updated = await tx.exam.update({
        where: { id: exam.id },
        data: { status: 'PUBLISHED', code, publishedAt: new Date() },
      });
      return { exam: updated };
    });

    const fresh = await this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (published) {
      await this.audit.log({
        actorId: payment.userId,
        action: 'payment.captured',
        entity: 'Payment',
        entityId: payment.id,
        meta: { via, examId: payment.examId },
      });
      if (payment.purpose === 'EXAM_JOIN') {
        await this.afterEnroll(payment.id, payment.userId, published, fresh);
      } else if (payment.purpose === 'SEAT_PACK') {
        const buyer = await this.prisma.user.findUnique({ where: { id: payment.userId } });
        if (buyer && published.exam) {
          await this.mail.sendSeatReceipt(buyer.email, buyer.name, {
            examTitle: published.exam.title,
            seats: payment.quantity,
            receiptNo: formatReceiptNo(fresh.receiptNo),
            amountPaise: fresh.amountPaise,
            paidAt: fresh.capturedAt ?? new Date(),
          });
        } else if (!published.exam) {
          await this.flagOrphan(payment.id);
        }
      } else if (!published.exam) {
        // Paid, but the exam was deleted meanwhile: flag for a manual refund.
        await this.flagOrphan(payment.id);
      } else if (published.exam.code) {
        const user = await this.prisma.user.findUnique({ where: { id: payment.userId } });
        if (user && published.exam.endsAt && published.exam.endsAt <= new Date()) {
          // Published, but the window is already over: tell the trainer to extend it.
          await this.mail.sendWindowPassed(user.email, user.name, {
            examTitle: published.exam.title,
          });
        }
        if (user) {
          await this.mail.sendPublishReceipt(user.email, user.name, {
            examTitle: published.exam.title,
            code: published.exam.code,
            receiptNo: formatReceiptNo(fresh.receiptNo),
            amountPaise: fresh.amountPaise,
            paidAt: fresh.capturedAt ?? new Date(),
          });
        }
      }
    }
    return fresh;
  }

  // ------------------------------------------------------------ join (students)

  /** Starts (or resumes) the join-fee payment for a published exam. */
  async createJoinOrder(user: AuthUser, rawCode: string): Promise<PublishOrderDto> {
    const exam = await this.prisma.exam.findUnique({
      where: { code: normalizeCode(rawCode) },
    });
    if (!exam || exam.status !== 'PUBLISHED') throw new NotFoundException('Exam code not found');
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: user.id } },
    });
    const state = computeJoinState({
      startsAt: exam.startsAt,
      endsAt: exam.endsAt,
      alreadyEnrolled: Boolean(enrolled),
    });
    if (state === 'ALREADY_ENROLLED')
      throw new ConflictException('You have already joined this exam');
    if (state === 'ENDED') throw new ConflictException('This exam has ended');

    const fees = await this.settings.get();
    const existing = await this.prisma.payment.findFirst({
      where: {
        examId: exam.id,
        userId: user.id,
        purpose: 'EXAM_JOIN',
        status: 'CREATED',
        provider: this.provider.name,
        amountPaise: fees.examJoinPaise,
      },
      orderBy: { createdAt: 'desc' },
    });
    let orderId = existing?.providerOrderId;
    if (!orderId) {
      const order = await this.provider.createOrder({
        amountPaise: fees.examJoinPaise,
        currency: PRICING.CURRENCY,
        receipt: `join_${exam.id.slice(0, 8)}_${Date.now().toString(36)}`,
      });
      orderId = order.orderId;
      await this.prisma.payment.create({
        data: {
          userId: user.id,
          examId: exam.id,
          purpose: 'EXAM_JOIN',
          amountPaise: fees.examJoinPaise,
          currency: PRICING.CURRENCY,
          provider: this.provider.name,
          providerOrderId: orderId,
        },
      });
      await this.audit.log({
        actorId: user.id,
        action: 'payment.order.join',
        entity: 'Exam',
        entityId: exam.id,
      });
    }
    return {
      provider: this.provider.name,
      orderId,
      amountPaise: fees.examJoinPaise,
      currency: PRICING.CURRENCY,
      keyId: this.provider.publicKeyId,
      description: `Join exam: ${exam.title}`.slice(0, 250),
    };
  }

  // ------------------------------------------------------------ sponsored seats

  /** A trainer buys N seats for their students in one order (N x the join fee). */
  async createSeatOrder(user: AuthUser, examId: string, seats: number): Promise<PublishOrderDto> {
    if (seats < 1 || seats > SEAT_LIMITS.MAX_PER_ORDER) {
      throw new BadRequestException(
        `Buy between 1 and ${SEAT_LIMITS.MAX_PER_ORDER} seats at a time`,
      );
    }
    const exam = UUID.test(examId)
      ? await this.prisma.exam.findFirst({
          where: { id: examId, examinerId: user.id },
        })
      : null;
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status !== 'PUBLISHED') {
      throw new ConflictException('Seats can be bought once the exam is published');
    }
    if (exam.endsAt && exam.endsAt <= new Date())
      throw new ConflictException('This exam has ended');

    const fees = await this.settings.get();
    const amountPaise = fees.examJoinPaise * seats;
    const order = await this.provider.createOrder({
      amountPaise,
      currency: PRICING.CURRENCY,
      receipt: `seats_${exam.id.slice(0, 8)}_${Date.now().toString(36)}`,
    });
    await this.prisma.payment.create({
      data: {
        userId: user.id,
        examId: exam.id,
        purpose: 'SEAT_PACK',
        amountPaise,
        quantity: seats,
        currency: PRICING.CURRENCY,
        provider: this.provider.name,
        providerOrderId: order.orderId,
      },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'payment.order.seats',
      entity: 'Exam',
      entityId: exam.id,
      meta: { seats },
    });
    return {
      provider: this.provider.name,
      orderId: order.orderId,
      amountPaise,
      currency: PRICING.CURRENCY,
      keyId: this.provider.publicKeyId,
      description: `${seats} seat${seats === 1 ? '' : 's'} for: ${exam.title}`.slice(0, 250),
    };
  }

  /** Runs inside the capture transaction: creates the paid seats. */
  private async createSeatPack(
    tx: Prisma.TransactionClient,
    payment: { id: string; userId: string; examId: string | null; quantity: number },
  ) {
    const exam = payment.examId
      ? await tx.exam.findUnique({ where: { id: payment.examId } })
      : null;
    if (!exam) return { exam: null };
    const pack = await tx.seatPack.create({
      data: {
        examId: exam.id,
        sponsorId: payment.userId,
        paymentId: payment.id,
        seats: payment.quantity,
      },
    });
    await tx.seat.createMany({
      data: Array.from({ length: payment.quantity }, () => ({
        packId: pack.id,
        token: seatToken(),
      })),
    });
    return { exam };
  }

  // ------------------------------------------------------------------ refunds

  /**
   * Admin-initiated refund. The gateway sends the money back, the ledger reverses both shares
   * (so the trainer's accrued share goes down too) and the seat or enrollment is cancelled.
   */
  async refund(admin: AuthUser, paymentId: string, reason: string) {
    const payment = UUID.test(paymentId)
      ? await this.prisma.payment.findUnique({
          where: { id: paymentId },
          include: {
            user: { select: { name: true, email: true } },
            exam: { select: { title: true } },
            enrollment: { include: { attempt: { select: { id: true } } } },
            seatPack: { include: { items: true } },
          },
        })
      : null;
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status === 'REFUNDED')
      throw new ConflictException('This payment is already refunded');
    if (payment.status !== 'CAPTURED' || !payment.providerPaymentId) {
      throw new ConflictException('Only a captured payment can be refunded');
    }
    if (payment.purpose === 'EXAM_CREATION') {
      throw new ConflictException('Exam creation fees are not refunded here');
    }
    if (payment.enrollment?.attempt) {
      throw new ConflictException(
        'This student has already started the exam, so the seat cannot be cancelled',
      );
    }
    if (payment.seatPack?.items.some((i) => i.redeemedAt)) {
      throw new ConflictException(
        'Some of these seats were already used, so the order cannot be refunded',
      );
    }

    // Claim first so two admins cannot refund the same payment twice.
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: 'CAPTURED' },
      data: { status: 'REFUNDED', refundedAt: new Date(), refundReason: reason },
    });
    if (claimed.count === 0) throw new ConflictException('This payment is already refunded');

    let refundId: string;
    try {
      refundId = (await this.provider.refund(payment.providerPaymentId, payment.amountPaise))
        .refundId;
    } catch (err) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'CAPTURED', refundedAt: null, refundReason: null },
      });
      this.logger.error('Refund failed at the gateway', err as Error);
      throw new ServiceUnavailableException(
        'The payment gateway could not process the refund. Try again.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const original = await tx.ledgerEntry.findMany({
        where: { paymentId: payment.id, type: 'CREDIT' },
      });
      await this.ledger.post(
        tx,
        reverseLines(
          original.map((e) => ({
            account: e.account,
            amountPaise: e.amountPaise,
            examId: e.examId,
            note: e.note ?? undefined,
          })),
        ),
        { type: 'REFUND', paymentId: payment.id },
      );
      if (payment.enrollment) await tx.enrollment.delete({ where: { id: payment.enrollment.id } });
      if (payment.seatPack) await tx.seatPack.delete({ where: { id: payment.seatPack.id } });
      await tx.payment.update({ where: { id: payment.id }, data: { refundId } });
    });
    await this.audit.log({
      actorId: admin.id,
      action: 'payment.refund',
      entity: 'Payment',
      entityId: payment.id,
      meta: { amountPaise: payment.amountPaise, reason, refundId },
    });
    await this.mail.sendRefundNotice(payment.user.email, payment.user.name, {
      amountPaise: payment.amountPaise,
      what:
        payment.purpose === 'SEAT_PACK'
          ? `${payment.quantity} seat(s) in "${payment.exam?.title ?? 'an exam'}"`
          : `your seat in "${payment.exam?.title ?? 'an exam'}"`,
      reason,
    });
    return { refunded: true as const, refundId };
  }

  /** Recent payments for the admin to find and refund. */
  /** Money taken but nothing delivered: mark it so the admin console lists it for a refund. */
  private async flagOrphan(paymentId: string, reason?: string) {
    const payment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { needsRefund: true },
    });
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { email: true },
    });
    for (const a of admins) {
      await this.mail.sendRefundNeeded(a.email, {
        receiptNo: formatReceiptNo(payment.receiptNo),
        amountPaise: payment.amountPaise,
        reason: reason ?? 'no seat or exam',
      });
    }
    await this.audit.log({
      action: 'payment.orphan',
      entity: 'Payment',
      entityId: paymentId,
      meta: reason ? { reason } : undefined,
    });
  }

  async listForAdmin(filter: {
    status?: string;
    purpose?: string;
    q?: string;
  }): Promise<AdminPaymentRow[]> {
    const rows = await this.prisma.payment.findMany({
      where: {
        status: (['CREATED', 'CAPTURED', 'FAILED', 'REFUNDED'] as const).find(
          (s) => s === filter.status,
        ),
        purpose: (['EXAM_CREATION', 'EXAM_JOIN', 'SEAT_PACK'] as const).find(
          (p) => p === filter.purpose,
        ),
        ...(filter.q
          ? {
              OR: [
                { user: { email: { contains: filter.q, mode: 'insensitive' as const } } },
                { user: { name: { contains: filter.q, mode: 'insensitive' as const } } },
                { exam: { title: { contains: filter.q, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { name: true, email: true } }, exam: { select: { title: true } } },
    });
    return rows.map((p) => ({
      id: p.id,
      receiptNo: formatReceiptNo(p.receiptNo),
      purpose: p.purpose,
      status: p.status,
      amountPaise: p.amountPaise,
      userName: p.user.name,
      userEmail: p.user.email,
      examTitle: p.exam?.title ?? null,
      quantity: p.quantity,
      capturedAt: p.capturedAt?.toISOString() ?? null,
      refundedAt: p.refundedAt?.toISOString() ?? null,
      refundReason: p.refundReason,
      needsRefund: p.needsRefund,
    }));
  }

  /** Runs inside the capture transaction: takes a seat, or explains why it could not. */
  private async enroll(
    tx: Prisma.TransactionClient,
    payment: { id: string; userId: string; examId: string | null },
  ) {
    const exam = payment.examId
      ? await tx.exam.findUnique({ where: { id: payment.examId } })
      : null;
    if (!exam || exam.status !== 'PUBLISHED' || (exam.endsAt && exam.endsAt <= new Date())) {
      return { exam, enrollment: null, reason: 'EXAM_UNAVAILABLE' };
    }
    const already = await tx.enrollment.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: payment.userId } },
    });
    if (already) return { exam, enrollment: null, reason: 'DUPLICATE' };
    const enrollment = await tx.enrollment.create({
      data: { examId: exam.id, studentId: payment.userId, paymentId: payment.id },
    });
    return { exam, enrollment, reason: null };
  }

  private async afterEnroll(
    paymentId: string,
    userId: string,
    result: {
      exam: { title: string; startsAt: Date | null; endsAt: Date | null } | null;
      enrollment?: unknown;
      reason?: string | null;
    },
    payment: { receiptNo: number; amountPaise: number; capturedAt: Date | null },
  ) {
    if (!result.enrollment || !result.exam) {
      // Money taken but no seat: flag for a manual refund.
      await this.flagOrphan(paymentId, result.reason ?? 'UNKNOWN');
      return;
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await this.mail.sendJoinReceipt(user.email, user.name, {
        examTitle: result.exam.title,
        startsAt: result.exam.startsAt,
        endsAt: result.exam.endsAt,
        receiptNo: formatReceiptNo(payment.receiptNo),
        amountPaise: payment.amountPaise,
        paidAt: payment.capturedAt ?? new Date(),
      });
    }
  }
}

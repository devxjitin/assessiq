import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import {
  PRICING,
  formatReceiptNo,
  type PublishOrderDto,
  type PublishResultDto,
  type VerifyPaymentInput,
} from '@assessiq/shared';
import { computeJoinState, normalizeCode } from '../enrollments/join-state';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
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
    if (exam.questionsPerStudent && exam.questionsPerStudent > exam._count.questions) {
      problems.push('Questions per student is more than the number of questions in the exam.');
    }
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

    const existing = await this.prisma.payment.findFirst({
      where: { examId, purpose: 'EXAM_CREATION', status: 'CREATED', provider: this.provider.name },
      orderBy: { createdAt: 'desc' },
    });
    let orderId = existing?.providerOrderId;
    if (!orderId) {
      const order = await this.provider.createOrder({
        amountPaise: PRICING.EXAM_CREATION_PAISE,
        currency: PRICING.CURRENCY,
        receipt: `exam_${exam.id.slice(0, 8)}_${Date.now().toString(36)}`,
      });
      orderId = order.orderId;
      await this.prisma.payment.create({
        data: {
          userId: user.id,
          examId,
          purpose: 'EXAM_CREATION',
          amountPaise: PRICING.EXAM_CREATION_PAISE,
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
      amountPaise: PRICING.EXAM_CREATION_PAISE,
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
        where: { id: payment.id, status: { not: 'CAPTURED' } },
        data: {
          status: 'CAPTURED',
          providerPaymentId: paymentId,
          capturedAt: new Date(),
          failureReason: null,
        },
      });
      if (claimed.count === 0) return null;

      if (payment.purpose === 'EXAM_JOIN') return this.enroll(tx, payment);
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
      } else if (!published.exam) {
        // Paid, but the exam was deleted meanwhile: flag for a manual refund.
        await this.audit.log({ action: 'payment.orphan', entity: 'Payment', entityId: payment.id });
      } else if (published.exam.code) {
        const user = await this.prisma.user.findUnique({ where: { id: payment.userId } });
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
      include: { _count: { select: { enrollments: true } } },
    });
    if (!exam || exam.status !== 'PUBLISHED') throw new NotFoundException('Exam code not found');
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: user.id } },
    });
    const state = computeJoinState({
      startsAt: exam.startsAt,
      endsAt: exam.endsAt,
      maxStudents: exam.maxStudents,
      seatsTaken: exam._count.enrollments,
      alreadyEnrolled: Boolean(enrolled),
    });
    if (state === 'ALREADY_ENROLLED')
      throw new ConflictException('You have already joined this exam');
    if (state === 'ENDED') throw new ConflictException('This exam has ended');
    if (state === 'FULL') throw new ConflictException('This exam is full');

    const existing = await this.prisma.payment.findFirst({
      where: {
        examId: exam.id,
        userId: user.id,
        purpose: 'EXAM_JOIN',
        status: 'CREATED',
        provider: this.provider.name,
      },
      orderBy: { createdAt: 'desc' },
    });
    let orderId = existing?.providerOrderId;
    if (!orderId) {
      const order = await this.provider.createOrder({
        amountPaise: PRICING.EXAM_JOIN_PAISE,
        currency: PRICING.CURRENCY,
        receipt: `join_${exam.id.slice(0, 8)}_${Date.now().toString(36)}`,
      });
      orderId = order.orderId;
      await this.prisma.payment.create({
        data: {
          userId: user.id,
          examId: exam.id,
          purpose: 'EXAM_JOIN',
          amountPaise: PRICING.EXAM_JOIN_PAISE,
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
      amountPaise: PRICING.EXAM_JOIN_PAISE,
      currency: PRICING.CURRENCY,
      keyId: this.provider.publicKeyId,
      description: `Join exam: ${exam.title}`.slice(0, 250),
    };
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
    const taken = await tx.enrollment.count({ where: { examId: exam.id } });
    if (taken >= exam.maxStudents) return { exam, enrollment: null, reason: 'FULL' };
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
      await this.audit.log({
        action: 'payment.orphan',
        entity: 'Payment',
        entityId: paymentId,
        meta: { reason: result.reason ?? 'UNKNOWN' },
      });
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

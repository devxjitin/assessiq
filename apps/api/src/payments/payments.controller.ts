import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  buySeatsSchema,
  fakeCompleteSchema,
  refundSchema,
  verifyPaymentSchema,
  type BuySeatsInput,
  type FakeCompleteInput,
  type RefundInput,
  type VerifyPaymentInput,
} from '@assessiq/shared';
import { AuthUser, CurrentUser, Public, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { PaymentsService } from './payments.service';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Step 1 of publishing: create (or resume) the creation-fee order. */
  @Roles('EXAMINER')
  @Post('exams/:id/publish-order')
  @HttpCode(200)
  createOrder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.createPublishOrder(user, id);
  }

  /** Trainer: buy seats for students (N x the join fee). */
  @Roles('EXAMINER')
  @Post('exams/:id/seats/order')
  @HttpCode(200)
  createSeatOrder(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(buySeatsSchema)) body: BuySeatsInput,
  ) {
    return this.payments.createSeatOrder(user, id, body.seats);
  }

  /** Admin: find payments. */
  @Roles('ADMIN')
  @Get('admin/finance/payments')
  adminList(
    @Query('status') status?: string,
    @Query('purpose') purpose?: string,
    @Query('q') q?: string,
  ) {
    return this.payments.listForAdmin({ status, purpose, q: q?.trim() || undefined });
  }

  /** Admin: refund a payment. Reverses the trainer's share and cancels the seat. */
  @Roles('ADMIN')
  @Post('admin/finance/payments/:id/refund')
  @HttpCode(200)
  adminRefund(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(refundSchema)) body: RefundInput,
  ) {
    return this.payments.refund(admin, id, body.reason);
  }

  /** Student: start (or resume) the join-fee order for an exam code. */
  @Roles('STUDENT')
  @Post('join/:code/order')
  @HttpCode(200)
  createJoinOrder(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.payments.createJoinOrder(user, code);
  }

  /** Step 2: the browser reports the gateway's result; the signature is checked server-side. */
  @Roles('EXAMINER', 'STUDENT')
  @Post('payments/verify')
  @HttpCode(200)
  verify(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(verifyPaymentSchema)) body: VerifyPaymentInput,
  ) {
    return this.payments.verify(user, body);
  }

  /** Fake provider only: stands in for the gateway's checkout. 404 when real payments are on. */
  @Roles('EXAMINER', 'STUDENT')
  @Post('payments/fake/complete')
  @HttpCode(200)
  fakeComplete(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(fakeCompleteSchema)) body: FakeCompleteInput,
  ) {
    return this.payments.fakeComplete(user, body.orderId);
  }

  /** Called by the gateway, not by a user: authenticated by its signature instead of a token. */
  @Public()
  @SkipThrottle()
  @Post('payments/webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
    @Body() body: unknown,
  ) {
    return this.payments.handleWebhook(req.rawBody, signature, eventId, body);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  directPayoutSchema,
  payPayoutSchema,
  payoutDetailsSchema,
  rejectPayoutSchema,
  type DirectPayoutInput,
  type PayPayoutInput,
  type PayoutDetailsInput,
  type RejectPayoutInput,
} from '@assessiq/shared';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { LedgerService } from '../ledger/ledger.service';
import { PayoutsService } from './payouts.service';

/** Trainer: earnings, where to send the money, and asking for a payout. */
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Roles('EXAMINER')
  @Get('earnings')
  earnings(@CurrentUser() user: AuthUser) {
    return this.payouts.earnings(user);
  }

  @Roles('EXAMINER')
  @Put('earnings/payout-details')
  saveDetails(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(payoutDetailsSchema)) body: PayoutDetailsInput,
  ) {
    return this.payouts.saveDetails(user, body);
  }

  @Roles('EXAMINER')
  @Post('payouts/request')
  @HttpCode(200)
  request(@CurrentUser() user: AuthUser) {
    return this.payouts.request(user);
  }

  /** The trainer's own payout, or any payout for an admin. */
  @Roles('EXAMINER', 'ADMIN')
  @Get('payouts/:id/statement.csv')
  async statement(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const { filename, body } = await this.payouts.statement(user, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }
}

/** NandiVex staff: who is owed, paying them, and checking the books. */
@Roles('ADMIN')
@Controller('admin/finance')
export class AdminFinanceController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly ledger: LedgerService,
  ) {}

  @Get('payable')
  payable() {
    return this.payouts.payable();
  }

  @Get('payouts')
  list(@Query('status') status?: string) {
    const ok = status === 'REQUESTED' || status === 'PAID' || status === 'REJECTED';
    return this.payouts.list(ok ? status : undefined);
  }

  @Post('payouts')
  @HttpCode(200)
  direct(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodValidationPipe(directPayoutSchema)) body: DirectPayoutInput,
  ) {
    return this.payouts.direct(admin, body);
  }

  @Post('payouts/:id/pay')
  @HttpCode(200)
  pay(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(payPayoutSchema)) body: PayPayoutInput,
  ) {
    return this.payouts.pay(admin, id, body);
  }

  @Post('payouts/:id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectPayoutSchema)) body: RejectPayoutInput,
  ) {
    return this.payouts.reject(admin, id, body);
  }

  @Post('examiners/:id/verify-details')
  @HttpCode(200)
  verify(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    return this.payouts.verifyDetails(admin, id);
  }

  /** Proof that the books balance. */
  @Get('ledger')
  check() {
    return this.ledger.check();
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  assignSeatsSchema,
  redeemSeatSchema,
  type AssignSeatsInput,
  type RedeemSeatInput,
} from '@assessiq/shared';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { SeatsService } from './seats.service';

@Controller()
export class SeatsController {
  constructor(private readonly seats: SeatsService) {}

  @Roles('EXAMINER')
  @Get('exams/:examId/seats')
  list(@CurrentUser() user: AuthUser, @Param('examId') examId: string) {
    return this.seats.list(user, examId);
  }

  @Roles('EXAMINER')
  @Post('exams/:examId/seats/assign')
  @HttpCode(200)
  assign(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Body(new ZodValidationPipe(assignSeatsSchema)) body: AssignSeatsInput,
  ) {
    return this.seats.assign(user, examId, body.emails);
  }

  /** Tokens are 160-bit secrets, but limit guessing anyway. */
  @Roles('STUDENT')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('seats/preview')
  preview(@Query('token') token = '') {
    return this.seats.preview(token);
  }

  @Roles('STUDENT')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('seats/redeem')
  @HttpCode(200)
  redeem(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(redeemSeatSchema)) body: RedeemSeatInput,
  ) {
    return this.seats.redeem(user, body.token);
  }
}

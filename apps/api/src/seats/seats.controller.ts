import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  assignSeatsSchema,
  reassignSeatSchema,
  redeemSeatSchema,
  type AssignSeatsInput,
  type ReassignSeatInput,
  type RedeemSeatInput,
} from '@assessiq/shared';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { RATE, perMinute } from '../common/rate-limits';
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

  @Roles('EXAMINER')
  @Put('exams/:examId/seats/:seatId/email')
  @HttpCode(200)
  reassign(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Param('seatId') seatId: string,
    @Body(new ZodValidationPipe(reassignSeatSchema)) body: ReassignSeatInput,
  ) {
    return this.seats.reassign(user, examId, seatId, body.email);
  }

  @Roles('EXAMINER')
  @Delete('exams/:examId/seats/:seatId/email')
  @HttpCode(200)
  unassign(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Param('seatId') seatId: string,
  ) {
    return this.seats.unassign(user, examId, seatId);
  }

  @Roles('EXAMINER')
  @Post('exams/:examId/seats/:seatId/resend')
  @HttpCode(200)
  resend(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Param('seatId') seatId: string,
  ) {
    return this.seats.resend(user, examId, seatId);
  }

  /** Tokens are 160-bit secrets, but limit guessing anyway. */
  @Roles('STUDENT')
  @Throttle({ default: perMinute(() => RATE.lookupIpPerMin) })
  @Get('seats/preview')
  preview(@Query('token') token = '') {
    return this.seats.preview(token);
  }

  @Roles('STUDENT')
  @Throttle({ default: perMinute(() => RATE.lookupIpPerMin) })
  @Post('seats/redeem')
  @HttpCode(200)
  redeem(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(redeemSeatSchema)) body: RedeemSeatInput,
  ) {
    return this.seats.redeem(user, body.token);
  }
}

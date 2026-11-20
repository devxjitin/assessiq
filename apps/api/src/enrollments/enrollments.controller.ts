import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { RATE, perMinute } from '../common/rate-limits';
import { EnrollmentsService } from './enrollments.service';

@Roles('STUDENT')
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  /** Looks up an exam by code. Rate limited so codes cannot be guessed in bulk. */
  @Throttle({ default: perMinute(() => RATE.lookupIpPerMin) })
  @Get('join/:code')
  joinInfo(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.enrollments.joinInfo(user, code);
  }

  @Get('me/enrollments')
  mine(@CurrentUser() user: AuthUser) {
    return this.enrollments.mine(user);
  }
}

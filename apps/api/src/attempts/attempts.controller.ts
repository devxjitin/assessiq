import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  proctorEventSchema,
  saveAnswerSchema,
  startAttemptSchema,
  type ProctorEventInput,
  type SaveAnswerInput,
  type StartAttemptInput,
} from '@assessiq/shared';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { ResultsService } from '../results/results.service';
import { AttemptsService } from './attempts.service';

/**
 * Autosave and proctor events are frequent and authenticated, and a whole classroom can share
 * one IP address, so the per-IP rate limit is switched off here.
 */
@Roles('STUDENT')
@SkipThrottle()
@Controller('attempts')
export class AttemptsController {
  constructor(
    private readonly attempts: AttemptsService,
    private readonly results: ResultsService,
  ) {}

  @Post()
  @HttpCode(200)
  start(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(startAttemptSchema)) body: StartAttemptInput,
  ) {
    return this.attempts.start(user, body.enrollmentId);
  }

  @Get(':id')
  view(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attempts.view(user, id);
  }

  /** Only available once the trainer has published results. */
  @Get(':id/result')
  result(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.results.studentResult(user, id);
  }

  @Put(':id/answers/:questionId')
  save(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('questionId') questionId: string,
    @Body(new ZodValidationPipe(saveAnswerSchema)) body: SaveAnswerInput,
  ) {
    return this.attempts.saveAnswer(user, id, questionId, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attempts.submit(user, id);
  }

  @Post(':id/events')
  @HttpCode(200)
  event(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(proctorEventSchema)) body: ProctorEventInput,
  ) {
    return this.attempts.recordEvent(user, id, body);
  }
}

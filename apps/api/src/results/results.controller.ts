import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { gradeAnswerSchema, type GradeAnswerInput } from '@assessiq/shared';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { ResultsService } from './results.service';

/** Trainer-only: results, marking and publishing for exams they own. */
@Roles('EXAMINER')
@Controller('exams/:examId')
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get('results')
  list(@CurrentUser() user: AuthUser, @Param('examId') examId: string) {
    return this.results.results(user, examId);
  }

  @Get('results.csv')
  async csv(@CurrentUser() user: AuthUser, @Param('examId') examId: string, @Res() res: Response) {
    const { filename, body } = await this.results.csv(user, examId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(body);
  }

  @Get('attempts/:attemptId')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Param('attemptId') attemptId: string,
  ) {
    return this.results.attemptDetail(user, examId, attemptId);
  }

  @Put('attempts/:attemptId/answers/:questionId/grade')
  grade(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Param('attemptId') attemptId: string,
    @Param('questionId') questionId: string,
    @Body(new ZodValidationPipe(gradeAnswerSchema)) body: GradeAnswerInput,
  ) {
    return this.results.gradeAnswer(user, examId, attemptId, questionId, body);
  }

  /** Pairs of coding answers that look copied. Advisory: a human decides. */
  @Get('similarity')
  similarity(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Query('threshold') threshold?: string,
  ) {
    return this.results.similarity(user, examId, threshold ? Number(threshold) : undefined);
  }

  /** Lets a student carry on a running attempt from another device. */
  @Post('attempts/:attemptId/release-device')
  @HttpCode(200)
  releaseDevice(
    @CurrentUser() user: AuthUser,
    @Param('examId') examId: string,
    @Param('attemptId') attemptId: string,
  ) {
    return this.results.releaseDevice(user, examId, attemptId);
  }

  @Post('finalize')
  @HttpCode(200)
  finalize(@CurrentUser() user: AuthUser, @Param('examId') examId: string) {
    return this.results.finalize(user, examId);
  }
}

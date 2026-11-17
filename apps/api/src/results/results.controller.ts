import { Body, Controller, Get, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
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

  @Post('finalize')
  @HttpCode(200)
  finalize(@CurrentUser() user: AuthUser, @Param('examId') examId: string) {
    return this.results.finalize(user, examId);
  }
}

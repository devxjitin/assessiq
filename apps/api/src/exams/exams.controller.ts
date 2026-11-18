import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  createExamSchema,
  importQuestionsSchema,
  questionInputSchema,
  reorderQuestionsSchema,
  updateExamSchema,
  type CreateExamInput,
  type ImportQuestionsInput,
  type QuestionInput,
  type ReorderQuestionsInput,
  type UpdateExamInput,
} from '@assessiq/shared';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { ExamsService } from './exams.service';

/** Trainer-only exam builder. Every route also checks that the exam belongs to the caller. */
@Roles('EXAMINER')
@Controller('exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createExamSchema)) body: CreateExamInput,
  ) {
    return this.exams.create(user, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.exams.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.exams.get(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateExamSchema)) body: UpdateExamInput,
  ) {
    return this.exams.update(user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.exams.remove(user, id);
  }

  @Post(':id/duplicate')
  @HttpCode(201)
  duplicate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.exams.duplicate(user, id);
  }

  @Get(':id/preview')
  preview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.exams.preview(user, id);
  }

  // ---- questions

  @Post(':id/questions')
  addQuestion(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(questionInputSchema)) body: QuestionInput,
  ) {
    return this.exams.addQuestion(user, id, body);
  }

  @Put(':id/questions/:questionId')
  updateQuestion(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('questionId') questionId: string,
    @Body(new ZodValidationPipe(questionInputSchema)) body: QuestionInput,
  ) {
    return this.exams.updateQuestion(user, id, questionId, body);
  }

  @Delete(':id/questions/:questionId')
  @HttpCode(204)
  async removeQuestion(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('questionId') questionId: string,
  ): Promise<void> {
    await this.exams.removeQuestion(user, id, questionId);
  }

  @Put(':id/questions-order')
  reorder(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reorderQuestionsSchema)) body: ReorderQuestionsInput,
  ) {
    return this.exams.reorder(user, id, body.questionIds);
  }

  @Post(':id/questions-import')
  @HttpCode(200)
  importQuestions(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(importQuestionsSchema)) body: ImportQuestionsInput,
  ) {
    return this.exams.importQuestions(user, id, body);
  }

  // ---- logo

  @Put(':id/logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 600 * 1024, files: 1 } }))
  setLogo(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.exams.setLogo(user, id, file?.buffer);
  }

  @Get(':id/logo')
  async getLogo(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const file = await this.exams.getLogo(user, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.body);
  }

  @Delete(':id/logo')
  @HttpCode(204)
  async removeLogo(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.exams.removeLogo(user, id);
  }
}

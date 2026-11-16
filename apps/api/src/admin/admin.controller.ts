import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { TokensService } from '../auth/tokens.service';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';

const listQuerySchema = z.object({
  role: z.enum(['STUDENT', 'EXAMINER', 'ADMIN']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
type ListQuery = z.infer<typeof listQuerySchema>;

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

/** NandiVex staff only. The whole controller is restricted to the ADMIN role. */
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
  ) {}

  @Get('users')
  async listUsers(@Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery) {
    const where = query.role ? { role: query.role } : {};
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          emailVerifiedAt: true,
          createdAt: true,
        },
      }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, users };
  }

  @Patch('users/:id/status')
  async setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
    @CurrentUser() actor: AuthUser,
    @Req() req: Request,
  ) {
    if (id === actor.id) throw new BadRequestException('You cannot change your own status');
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.user.update({ where: { id }, data: { status: body.status } });
    if (body.status === 'SUSPENDED') await this.tokens.revokeAllForUser(id);

    await this.audit.log({
      actorId: actor.id,
      action: body.status === 'SUSPENDED' ? 'admin.user_suspended' : 'admin.user_reactivated',
      entity: 'User',
      entityId: id,
      ip: requestMeta(req).ip,
    });
    return { id, status: body.status };
  }
}

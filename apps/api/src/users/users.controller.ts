import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AuthResponse,
  changePasswordSchema,
  updateProfileSchema,
  type ChangePasswordInput,
  type PublicUser,
  type UpdateProfileInput,
} from '@assessiq/shared';
import { AuthService } from '../auth/auth.service';
import { REFRESH_COOKIE } from '../auth/auth.controller';
import { AuthUser, CurrentUser } from '../common/decorators';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod.pipe';
import { ENV, Env } from '../config/env';
import { Inject } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users/me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  me(@CurrentUser() user: AuthUser): Promise<PublicUser> {
    return this.users.getProfile(user.id);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
    @Req() req: Request,
  ): Promise<PublicUser> {
    return this.users.updateProfile(user, body, requestMeta(req));
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const session = await this.auth.changePassword(user.id, body, requestMeta(req));
    // All old sessions were revoked; this response carries the fresh one.
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/auth',
      expires: session.refreshExpiresAt,
    });
    return session.response;
  }
}

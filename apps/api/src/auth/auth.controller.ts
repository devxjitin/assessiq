import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AuthResponse,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendOtpSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type ForgotPasswordInput,
  type LoginInput,
  type RegisterInput,
  type ResendOtpInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from '@assessiq/shared';
import { EmailSendLimit, SignInLimit } from '../common/account-rate-limit.guard';
import { Public } from '../common/decorators';
import { RATE, perMinute } from '../common/rate-limits';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod.pipe';
import { ENV, Env } from '../config/env';
import { AuthService, Session } from './auth.service';

export const REFRESH_COOKIE = 'aiq_rt';
const REFRESH_COOKIE_PATH = '/auth';
const GENERIC_OK = { message: 'If the details are correct, an email is on its way.' };

// Auth endpoints are brute-force and email-flooding targets. Per IP there is only a generous ceiling
// (a classroom shares one IP); the real limits are per account: SignInLimit (email + network) for
// sign-in and code entry, EmailSendLimit (email) for routes that send mail.
const SIGNUP_IP = { default: perMinute(() => RATE.signupIpPerMin) };
const LOGIN_IP = { default: perMinute(() => RATE.loginIpPerMin) };

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('register')
  @HttpCode(202)
  @Throttle(SIGNUP_IP)
  @UseGuards(EmailSendLimit)
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Req() req: Request,
  ) {
    await this.auth.register(body, requestMeta(req));
    return GENERIC_OK;
  }

  @Post('verify-email')
  @HttpCode(200)
  @Throttle(LOGIN_IP)
  @UseGuards(SignInLimit)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: VerifyEmailInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.verifyEmail(body, requestMeta(req)));
  }

  @Post('resend-code')
  @HttpCode(202)
  @Throttle(SIGNUP_IP)
  @UseGuards(EmailSendLimit)
  async resendCode(@Body(new ZodValidationPipe(resendOtpSchema)) body: ResendOtpInput) {
    await this.auth.resendCode(body.email, body.purpose);
    return GENERIC_OK;
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(LOGIN_IP)
  @UseGuards(SignInLimit)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.login(body, requestMeta(req)));
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: perMinute(() => RATE.refreshIpPerMin) })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    try {
      return this.respond(res, await this.auth.refresh(token, requestMeta(req)));
    } catch (err) {
      this.clearCookie(res);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    this.clearCookie(res);
  }

  @Post('forgot-password')
  @HttpCode(202)
  @Throttle(SIGNUP_IP)
  @UseGuards(EmailSendLimit)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput,
  ) {
    await this.auth.forgotPassword(body.email);
    return GENERIC_OK;
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle(LOGIN_IP)
  @UseGuards(SignInLimit)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
    @Req() req: Request,
  ) {
    await this.auth.resetPassword(body, requestMeta(req));
    return { message: 'Password updated. You can now sign in.' };
  }

  private respond(res: Response, session: Session): AuthResponse {
    this.setCookie(res, session);
    return session.response;
  }

  private setCookie(res: Response, session: Session): void {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      expires: session.refreshExpiresAt,
    });
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
    });
  }
}

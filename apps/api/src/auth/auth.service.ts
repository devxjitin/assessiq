import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { OtpPurpose, User } from '@prisma/client';
import type {
  AuthResponse,
  ChangePasswordInput,
  LoginInput,
  PublicUser,
  RegisterInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from '@assessiq/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { ENV, Env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { TokensService } from './tokens.service';

export interface Session {
  response: AuthResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

type UserWithProfile = User & { examinerProfile?: { orgName: string | null } | null };

export function toPublicUser(user: UserWithProfile): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: user.phone,
    orgName: user.examinerProfile?.orgName ?? null,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokensService,
    private readonly otp: OtpService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registration never reveals whether an email is already taken: the response is always the
   * same, and existing owners are told by email instead.
   */
  async register(input: RegisterInput, meta: RequestMeta): Promise<void> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });

    if (existing) {
      if (existing.emailVerifiedAt) {
        await this.mail.sendAccountExists(existing.email, existing.name);
      } else {
        await this.sendCode(existing, 'VERIFY_EMAIL');
      }
      return;
    }

    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        phone: input.phone,
        passwordHash,
        role: input.role,
        examinerProfile:
          input.role === 'EXAMINER' ? { create: { orgName: input.orgName ?? null } } : undefined,
      },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'auth.register',
      entity: 'User',
      entityId: user.id,
      meta: { role: user.role },
      ip: meta.ip,
    });
    await this.sendCode(user, 'VERIFY_EMAIL');
  }

  async verifyEmail(input: VerifyEmailInput, meta: RequestMeta): Promise<Session> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { examinerProfile: true },
    });
    if (!user || user.emailVerifiedAt) {
      // Same error as a wrong code, so this endpoint cannot be used to probe accounts.
      throw new BadRequestException('Invalid or expired code');
    }
    await this.otp.verify(user.id, 'VERIFY_EMAIL', input.code);

    const verified = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
      include: { examinerProfile: true },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'auth.verify_email',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
    });
    return this.startSession(verified, meta);
  }

  async resendCode(email: string, purpose: OtpPurpose): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') return;
    // VERIFY_EMAIL is only for unverified accounts, RESET_PASSWORD only for verified ones.
    if (purpose === 'VERIFY_EMAIL' && user.emailVerifiedAt) return;
    if (purpose === 'RESET_PASSWORD' && !user.emailVerifiedAt) return;
    await this.sendCode(user, purpose);
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<Session> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { examinerProfile: true },
    });

    if (!user) {
      await this.passwords.verifyDummy(input.password);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        'Too many failed attempts. Try again later or reset your password.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const passwordOk = await this.passwords.verify(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.recordFailedLogin(user, meta);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException('This account has been suspended. Contact support.');
    }

    if (!user.emailVerifiedAt) {
      // Only someone who knows the password learns this, and gets a fresh code to finish signing up.
      await this.sendCode(user, 'VERIFY_EMAIL');
      throw new ForbiddenException({
        statusCode: 403,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email. We sent you a new code.',
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
    });
    return this.startSession(user, meta);
  }

  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<Session> {
    const rotated = await this.tokens.rotate(rawToken, meta);
    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
      include: { examinerProfile: true },
    });
    if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      await this.tokens.revokeAllForUser(rotated.userId);
      throw new UnauthorizedException('Account is not active');
    }
    return {
      response: this.buildResponse(user),
      refreshToken: rotated.token,
      refreshExpiresAt: rotated.expiresAt,
    };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    await this.tokens.revoke(rawToken);
  }

  async forgotPassword(email: string): Promise<void> {
    await this.resendCode(email, 'RESET_PASSWORD');
  }

  async resetPassword(input: ResetPasswordInput, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !user.emailVerifiedAt) {
      throw new BadRequestException('Invalid or expired code');
    }
    await this.otp.verify(user.id, 'RESET_PASSWORD', input.code);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(input.newPassword),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    // Sign the user out everywhere: whoever had access before can no longer refresh.
    await this.tokens.revokeAllForUser(user.id);
    await this.audit.log({
      actorId: user.id,
      action: 'auth.password_reset',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
    });
    await this.mail.sendPasswordChanged(user.email, user.name);
  }

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    meta: RequestMeta,
  ): Promise<Session> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { examinerProfile: true },
    });
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(input.newPassword) },
    });
    await this.tokens.revokeAllForUser(userId);
    await this.audit.log({
      actorId: userId,
      action: 'auth.password_changed',
      entity: 'User',
      entityId: userId,
      ip: meta.ip,
    });
    await this.mail.sendPasswordChanged(user.email, user.name);
    return this.startSession(user, meta);
  }

  private async recordFailedLogin(user: User, meta: RequestMeta): Promise<void> {
    const failures = user.failedLoginCount + 1;
    const lock = failures >= this.env.LOGIN_MAX_FAILURES;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: lock ? 0 : failures,
        lockedUntil: lock ? new Date(Date.now() + this.env.LOCK_MINUTES * 60_000) : undefined,
      },
    });
    await this.audit.log({
      actorId: user.id,
      action: lock ? 'auth.account_locked' : 'auth.login_failed',
      entity: 'User',
      entityId: user.id,
      ip: meta.ip,
    });
  }

  private async sendCode(user: User, purpose: OtpPurpose): Promise<void> {
    let code: string;
    try {
      code = await this.otp.issue(user.id, purpose);
    } catch (err) {
      // Too soon after the previous code: the earlier email is still valid, so do nothing.
      if (err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS) return;
      throw err;
    }
    if (purpose === 'VERIFY_EMAIL') {
      await this.mail.sendVerificationCode(user.email, user.name, code);
    } else {
      await this.mail.sendPasswordResetCode(user.email, user.name, code);
    }
  }

  private async startSession(user: UserWithProfile, meta: RequestMeta): Promise<Session> {
    const refresh = await this.tokens.issueRefresh(user.id, meta);
    return {
      response: this.buildResponse(user),
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private buildResponse(user: UserWithProfile): AuthResponse {
    return {
      accessToken: this.tokens.signAccess(user),
      expiresInSeconds: this.tokens.accessTtlSeconds,
      user: toPublicUser(user),
    };
  }
}

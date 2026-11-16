import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import {
  LogTransport,
  MailMessage,
  MailTransport,
  MemoryTransport,
  SesTransport,
} from './transports';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export function createTransport(env: Env): MailTransport {
  switch (env.MAIL_TRANSPORT) {
    case 'ses':
      return new SesTransport(env.AWS_REGION, env.SES_FROM_EMAIL, env.SES_CONFIGURATION_SET);
    case 'memory':
      return new MemoryTransport();
    default:
      return new LogTransport();
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(title: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
<h2 style="margin:0 0 16px">${esc(title)}</h2>${bodyHtml}
<p style="color:#666;font-size:12px;margin-top:32px">AssessIQ by NandiVex Technologies. If you did not request this, you can ignore this email.</p></div>`;
}

function codeBlock(code: string): string {
  return `<p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0">${esc(code)}</p>`;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Sends the email; failures are logged, never thrown (the user can request another code). */
  private async deliver(message: MailMessage): Promise<void> {
    try {
      await this.transport.send(message);
    } catch (err) {
      this.logger.error(`Failed to send "${message.subject}" email`, err as Error);
    }
  }

  sendVerificationCode(to: string, name: string, code: string) {
    const minutes = this.env.OTP_TTL_MIN;
    return this.deliver({
      to,
      subject: 'Verify your AssessIQ email',
      text: `Hi ${name},\n\nYour AssessIQ verification code is ${code}. It expires in ${minutes} minutes.\n`,
      html: layout(
        'Verify your email',
        `<p>Hi ${esc(name)}, use this code to verify your email. It expires in ${minutes} minutes.</p>${codeBlock(code)}`,
      ),
    });
  }

  sendPasswordResetCode(to: string, name: string, code: string) {
    const minutes = this.env.OTP_TTL_MIN;
    return this.deliver({
      to,
      subject: 'Reset your AssessIQ password',
      text: `Hi ${name},\n\nYour password reset code is ${code}. It expires in ${minutes} minutes.\n`,
      html: layout(
        'Reset your password',
        `<p>Hi ${esc(name)}, use this code to reset your password. It expires in ${minutes} minutes.</p>${codeBlock(code)}`,
      ),
    });
  }

  sendAccountExists(to: string, name: string) {
    return this.deliver({
      to,
      subject: 'You already have an AssessIQ account',
      text: `Hi ${name},\n\nSomeone tried to register with this email, but you already have an account. Sign in, or use "Forgot password" if needed.\n`,
      html: layout(
        'You already have an account',
        `<p>Hi ${esc(name)}, someone tried to register with this email, but you already have an account. Sign in, or use “Forgot password” if you need to reset it.</p>`,
      ),
    });
  }

  sendPasswordChanged(to: string, name: string) {
    return this.deliver({
      to,
      subject: 'Your AssessIQ password was changed',
      text: `Hi ${name},\n\nYour password was just changed. If this was not you, reset your password immediately.\n`,
      html: layout(
        'Password changed',
        `<p>Hi ${esc(name)}, your password was just changed. If this was not you, reset your password immediately.</p>`,
      ),
    });
  }
}

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

  /** Sends a certificate with its PDF attached. Throws on failure so the caller can retry. */
  async sendCertificate(
    to: string,
    name: string,
    r: { examTitle: string; serialNo: string; verifyUrl: string; pdf: Buffer },
  ): Promise<string | undefined> {
    return this.transport.send({
      to,
      subject: `Your certificate for "${r.examTitle}"`,
      text: `Hi ${name},\n\nCongratulations! Your certificate for "${r.examTitle}" is attached.\n\nSerial: ${r.serialNo}\nAnyone can check it is genuine at:\n${r.verifyUrl}\n`,
      html: layout(
        'Your certificate is ready',
        `<p>Hi ${esc(name)}, your certificate for <strong>${esc(r.examTitle)}</strong> is attached to this email.</p><p style="font-size:14px">Serial: <strong>${esc(r.serialNo)}</strong><br>Anyone can check it is genuine at <a href="${esc(r.verifyUrl)}">${esc(r.verifyUrl)}</a></p>`,
      ),
      attachments: [
        {
          filename: `certificate-${r.serialNo}.pdf`,
          contentType: 'application/pdf',
          content: r.pdf,
        },
      ],
    });
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

  sendPublishReceipt(
    to: string,
    name: string,
    r: { examTitle: string; code: string; receiptNo: string; amountPaise: number; paidAt: Date },
  ) {
    const rupees = (r.amountPaise / 100).toFixed(2);
    const joinUrl = `${this.env.WEB_ORIGIN.split(',')[0].trim()}/join/?code=${encodeURIComponent(r.code)}`;
    const date = r.paidAt.toISOString().slice(0, 10);
    return this.deliver({
      to,
      subject: `Receipt ${r.receiptNo}: your exam is published`,
      text: `Hi ${name},

Your exam "${r.examTitle}" is published.

Exam code: ${r.code}
Share link: ${joinUrl}

Receipt ${r.receiptNo}, ${date}
Exam creation fee: INR ${rupees} (inclusive of applicable taxes)
`,
      html: layout(
        'Your exam is published',
        `<p>Hi ${esc(name)}, your exam <strong>${esc(r.examTitle)}</strong> is published. Share this code with your students:</p>${codeBlock(r.code)}<p>Or send them <a href="${esc(joinUrl)}">${esc(joinUrl)}</a></p><hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:14px">Receipt <strong>${esc(r.receiptNo)}</strong> · ${date}<br>Exam creation fee: INR ${rupees} (inclusive of applicable taxes)</p>`,
      ),
    });
  }

  sendPayoutPaid(
    to: string,
    name: string,
    r: { amountPaise: number; utr: string; destination: string; paidAt: Date },
  ) {
    const rupees = (r.amountPaise / 100).toFixed(2);
    const date = r.paidAt.toISOString().slice(0, 10);
    return this.deliver({
      to,
      subject: `Payout of INR ${rupees} sent`,
      text: `Hi ${name},\n\nNandiVex has sent your AssessIQ earnings.\n\nAmount: INR ${rupees}\nSent to: ${r.destination}\nReference (UTR): ${r.utr}\nDate: ${date}\n\nYou can download the statement from the Earnings page.\n`,
      html: layout(
        'Your payout was sent',
        `<p>Hi ${esc(name)}, NandiVex has sent your AssessIQ earnings.</p><p style="font-size:14px">Amount: <strong>INR ${rupees}</strong><br>Sent to: ${esc(r.destination)}<br>Reference (UTR): <strong>${esc(r.utr)}</strong><br>Date: ${date}</p><p>You can download the statement from the Earnings page.</p>`,
      ),
    });
  }

  sendRefundNotice(
    to: string,
    name: string,
    r: { amountPaise: number; what: string; reason: string },
  ) {
    const rupees = (r.amountPaise / 100).toFixed(2);
    return this.deliver({
      to,
      subject: `Refund of INR ${rupees}`,
      text: `Hi ${name},\n\nWe have refunded INR ${rupees} for ${r.what}.\nReason: ${r.reason}\nIt reaches your original payment method in a few working days.\n`,
      html: layout(
        'Your refund was issued',
        `<p>Hi ${esc(name)}, we have refunded <strong>INR ${rupees}</strong> for ${esc(r.what)}.</p><p style="font-size:14px">Reason: ${esc(r.reason)}</p><p>It reaches your original payment method in a few working days.</p>`,
      ),
    });
  }

  sendSeatInvite(to: string, r: { examTitle: string; trainerName: string; link: string }) {
    return this.deliver({
      to,
      subject: `${r.trainerName} has paid for your seat in "${r.examTitle}"`,
      text: `Hello,\n\n${r.trainerName} has reserved and paid for your seat in "${r.examTitle}" on AssessIQ. You do not need to pay.\n\nSign in (or create a student account with this email address) and open:\n${r.link}\n`,
      html: layout(
        'Your exam seat is paid for',
        `<p>${esc(r.trainerName)} has reserved and paid for your seat in <strong>${esc(r.examTitle)}</strong>. You do not need to pay.</p><p>Sign in (or create a student account with this email address) and open:<br><a href="${esc(r.link)}">${esc(r.link)}</a></p>`,
      ),
    });
  }

  sendSeatReceipt(
    to: string,
    name: string,
    r: { examTitle: string; seats: number; receiptNo: string; amountPaise: number; paidAt: Date },
  ) {
    const rupees = (r.amountPaise / 100).toFixed(2);
    const date = r.paidAt.toISOString().slice(0, 10);
    return this.deliver({
      to,
      subject: `Receipt ${r.receiptNo}: ${r.seats} seats for "${r.examTitle}"`,
      text: `Hi ${name},\n\nYou bought ${r.seats} seat(s) for "${r.examTitle}". Assign them to students from the Seats tab of the exam.\n\nReceipt ${r.receiptNo}, ${date}\nTotal: INR ${rupees} (inclusive of applicable taxes)\n`,
      html: layout(
        'Seats purchased',
        `<p>Hi ${esc(name)}, you bought <strong>${r.seats}</strong> seat(s) for <strong>${esc(r.examTitle)}</strong>. Assign them to students from the Seats tab of the exam.</p><hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:14px">Receipt <strong>${esc(r.receiptNo)}</strong> · ${date}<br>Total: INR ${rupees} (inclusive of applicable taxes)</p>`,
      ),
    });
  }

  sendJoinReceipt(
    to: string,
    name: string,
    r: {
      examTitle: string;
      startsAt: Date | null;
      endsAt: Date | null;
      receiptNo: string;
      amountPaise: number;
      paidAt: Date;
    },
  ) {
    const rupees = (r.amountPaise / 100).toFixed(2);
    const date = r.paidAt.toISOString().slice(0, 10);
    const window =
      r.startsAt && r.endsAt
        ? `Opens ${r.startsAt.toISOString()} and closes ${r.endsAt.toISOString()} (UTC).`
        : '';
    return this.deliver({
      to,
      subject: `Receipt ${r.receiptNo}: you have joined "${r.examTitle}"`,
      text: `Hi ${name},\n\nYou have joined "${r.examTitle}". ${window}\nSign in to AssessIQ to start the exam when it opens.\n\nReceipt ${r.receiptNo}, ${date}\nExam fee: INR ${rupees} (inclusive of applicable taxes)\n`,
      html: layout(
        'You have joined the exam',
        `<p>Hi ${esc(name)}, you have joined <strong>${esc(r.examTitle)}</strong>. ${esc(window)} Sign in to AssessIQ to start the exam when it opens.</p><hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:14px">Receipt <strong>${esc(r.receiptNo)}</strong> · ${date}<br>Exam fee: INR ${rupees} (inclusive of applicable taxes)</p>`,
      ),
    });
  }
}

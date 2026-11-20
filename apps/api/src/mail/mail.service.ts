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
<p style="color:#666;font-size:12px;margin-top:32px">Parakh by NandiVex Technologies. If you did not request this, you can ignore this email.</p></div>`;
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
      subject: 'Verify your Parakh email',
      text: `Hi ${name},\n\nYour Parakh verification code is ${code}. It expires in ${minutes} minutes.\n`,
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
      subject: 'Reset your Parakh password',
      text: `Hi ${name},\n\nYour password reset code is ${code}. It expires in ${minutes} minutes.\n`,
      html: layout(
        'Reset your password',
        `<p>Hi ${esc(name)}, use this code to reset your password. It expires in ${minutes} minutes.</p>${codeBlock(code)}`,
      ),
    });
  }

  /** Tells an admin that a customer paid but received nothing, so a refund is due. */
  sendRefundNeeded(to: string, r: { receiptNo: string; amountPaise: number; reason: string }) {
    const amount = '₹' + (r.amountPaise / 100).toFixed(2);
    return this.deliver({
      to,
      subject: `Refund needed: ${r.receiptNo}`,
      text: `Payment ${r.receiptNo} (${amount}) was taken but nothing was delivered (${r.reason}).
Open Admin > Payments and refund it.
`,
      html: layout(
        'Refund needed',
        `<p>Payment <b>${esc(r.receiptNo)}</b> (${esc(amount)}) was taken but nothing was delivered (${esc(r.reason)}). Open Admin &gt; Payments and refund it.</p>`,
      ),
    });
  }

  /** The trainer paid to publish, but the exam's closing time had already passed. */
  sendWindowPassed(to: string, name: string, r: { examTitle: string }) {
    return this.deliver({
      to,
      subject: `Extend the closing time of "${r.examTitle}"`,
      text: `Hi ${name},\n\nYour payment for "${r.examTitle}" went through, but the exam's closing time has already passed, so students cannot join. Open the exam on Parakh, go to Share, and use "Extend closing time".\n`,
      html: layout(
        'Extend the closing time',
        `<p>Hi ${esc(name)}, your payment for <strong>${esc(r.examTitle)}</strong> went through, but the exam's closing time has already passed, so students cannot join. Open the exam, go to Share, and use <em>Extend closing time</em>.</p>`,
      ),
    });
  }

  sendAccountExists(to: string, name: string) {
    return this.deliver({
      to,
      subject: 'You already have an Parakh account',
      text: `Hi ${name},\n\nSomeone tried to register with this email, but you already have an account. Sign in, or use "Forgot password" if needed.\n`,
      html: layout(
        'You already have an account',
        `<p>Hi ${esc(name)}, someone tried to register with this email, but you already have an account. Sign in, or use “Forgot password” if you need to reset it.</p>`,
      ),
    });
  }

  /** Sent to the old address after an account was closed, so a stranger cannot do it unnoticed. */
  sendAccountDeleted(to: string, name: string) {
    return this.deliver({
      to,
      subject: 'Your Parakh account was closed',
      text: `Hi ${name},\n\nYour Parakh account was closed and your name, email and phone were removed. Payment records and issued certificates are kept, as our privacy policy explains.\n\nIf this was not you, contact us straight away through the contact page.\n`,
      html: layout(
        'Your account was closed',
        `<p>Hi ${esc(name)}, your Parakh account was closed and your name, email and phone were removed. Payment records and issued certificates are kept, as our privacy policy explains.</p><p>If this was not you, contact us straight away through the contact page.</p>`,
      ),
    });
  }

  sendPasswordChanged(to: string, name: string) {
    return this.deliver({
      to,
      subject: 'Your Parakh password was changed',
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

  /** "Your results are out": sent once, when the trainer publishes. */
  sendResultsOut(to: string, name: string, r: { examTitle: string; attemptId: string }) {
    const url = `${this.env.WEB_ORIGIN.split(',')[0].trim()}/result/?id=${encodeURIComponent(r.attemptId)}`;
    return this.deliver({
      to,
      subject: `Your results are out: ${r.examTitle}`,
      text: `Hi ${name},\n\nThe results for "${r.examTitle}" are published. See your score and review your answers:\n${url}\n\nA practice set with the same questions is now open for you.\n`,
      html: layout(
        'Your results are out',
        `<p>Hi ${esc(name)}, the results for <strong>${esc(r.examTitle)}</strong> are published.</p><p><a href="${esc(url)}">See your score and review your answers</a></p><p>A practice set with the same questions is now open for you.</p>`,
      ),
    });
  }

  /** One reminder, about a day before an exam the student has joined. */
  sendExamReminder(
    to: string,
    name: string,
    r: { examTitle: string; startsAt: Date; durationMinutes: number },
  ) {
    const url = `${this.env.WEB_ORIGIN.split(',')[0].trim()}/dashboard/`;
    const when = r.startsAt.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return this.deliver({
      to,
      subject: `Reminder: ${r.examTitle} starts soon`,
      text: `Hi ${name},\n\nYour exam "${r.examTitle}" starts on ${when} (India time). You will have ${r.durationMinutes} minutes.\n\nOpen it from your dashboard: ${url}\n\nUse one device and a stable connection; leaving the exam window counts as a strike.\n`,
      html: layout(
        'Your exam starts soon',
        `<p>Hi ${esc(name)}, your exam <strong>${esc(r.examTitle)}</strong> starts on <strong>${esc(when)}</strong> (India time). You will have ${r.durationMinutes} minutes.</p><p><a href="${esc(url)}">Open your dashboard</a></p><p style="font-size:14px">Use one device and a stable connection; leaving the exam window counts as a strike.</p>`,
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
      text: `Hi ${name},\n\nNandiVex has sent your Parakh earnings.\n\nAmount: INR ${rupees}\nSent to: ${r.destination}\nReference (UTR): ${r.utr}\nDate: ${date}\n`,
      html: layout(
        'Your payout was sent',
        `<p>Hi ${esc(name)}, NandiVex has sent your Parakh earnings.</p><p style="font-size:14px">Amount: <strong>INR ${rupees}</strong><br>Sent to: ${esc(r.destination)}<br>Reference (UTR): <strong>${esc(r.utr)}</strong><br>Date: ${date}</p>`,
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

  /** A student asked for their exam fee back; tell the admins so it does not sit unseen. */
  sendRefundRequested(
    to: string,
    r: {
      receiptNo: string;
      amountPaise: number;
      studentName: string;
      examTitle: string;
      reason: string;
    },
  ) {
    const amount = '₹' + (r.amountPaise / 100).toFixed(2);
    return this.deliver({
      to,
      subject: `Refund request: ${r.receiptNo}`,
      text: `${r.studentName} asked for a refund of ${amount} for "${r.examTitle}" (${r.receiptNo}).\nReason: ${r.reason}\nOpen Admin > Payments > Refund requests to approve or reject it.\n`,
      html: layout(
        'Refund request',
        `<p><b>${esc(r.studentName)}</b> asked for a refund of ${esc(amount)} for &ldquo;${esc(r.examTitle)}&rdquo; (${esc(r.receiptNo)}).</p><p style="font-size:14px">Reason: ${esc(r.reason)}</p><p>Open Admin &gt; Payments &gt; Refund requests to approve or reject it.</p>`,
      ),
    });
  }

  sendRefundRequestRejected(
    to: string,
    name: string,
    r: { receiptNo: string; examTitle: string; note: string },
  ) {
    return this.deliver({
      to,
      subject: `Your refund request ${r.receiptNo} was not approved`,
      text: `Hi ${name},\n\nWe could not approve your refund request for "${r.examTitle}" (${r.receiptNo}).\nReason: ${r.note}\n\nIf you think this is wrong, reply through the contact page.\n`,
      html: layout(
        'Refund request not approved',
        `<p>Hi ${esc(name)}, we could not approve your refund request for &ldquo;${esc(r.examTitle)}&rdquo; (${esc(r.receiptNo)}).</p><p style="font-size:14px">Reason: ${esc(r.note)}</p><p>If you think this is wrong, reach us through the contact page.</p>`,
      ),
    });
  }

  sendSeatInvite(to: string, r: { examTitle: string; trainerName: string; link: string }) {
    return this.deliver({
      to,
      subject: `${r.trainerName} has paid for your seat in "${r.examTitle}"`,
      text: `Hello,\n\n${r.trainerName} has reserved and paid for your seat in "${r.examTitle}" on Parakh. You do not need to pay.\n\nSign in (or create a student account with this email address) and open:\n${r.link}\n`,
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
      text: `Hi ${name},\n\nYou have joined "${r.examTitle}". ${window}\nSign in to Parakh to start the exam when it opens.\n\nReceipt ${r.receiptNo}, ${date}\nExam fee: INR ${rupees} (inclusive of applicable taxes)\n`,
      html: layout(
        'You have joined the exam',
        `<p>Hi ${esc(name)}, you have joined <strong>${esc(r.examTitle)}</strong>. ${esc(window)} Sign in to Parakh to start the exam when it opens.</p><hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:14px">Receipt <strong>${esc(r.receiptNo)}</strong> · ${date}<br>Exam fee: INR ${rupees} (inclusive of applicable taxes)</p>`,
      ),
    });
  }
}

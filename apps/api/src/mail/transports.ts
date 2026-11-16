import { Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export class SesTransport implements MailTransport {
  private readonly client: SESv2Client;

  constructor(
    region: string,
    private readonly from: string,
    private readonly configurationSet?: string,
  ) {
    this.client = new SESv2Client({ region });
  }

  async send(message: MailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: `AssessIQ <${this.from}>`,
        Destination: { ToAddresses: [message.to] },
        ConfigurationSetName: this.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              Html: { Data: message.html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
  }
}

/** Development only: prints the email (including codes) to the console. */
export class LogTransport implements MailTransport {
  private readonly logger = new Logger('Mail');

  async send(message: MailMessage): Promise<void> {
    this.logger.log(`To: ${message.to} | ${message.subject}\n${message.text}`);
  }
}

/** Tests only: keeps messages in memory so a test can read the OTP code. */
export class MemoryTransport implements MailTransport {
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === email);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

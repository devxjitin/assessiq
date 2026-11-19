import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

/** How far ahead of the start time students are reminded. */
export const REMINDER_WINDOW_MS = 24 * 3_600_000;

/** Background notifications. Safe to run on several servers: each reminder is claimed once. */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    if (this.env.NOTIFY_JOBS_POLL !== 'on') return;
    this.timer = setInterval(() => void this.sendReminders(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Emails students who joined an exam that starts within a day and have not started it. Each
   * enrollment is claimed before its email goes out, so nobody gets two.
   */
  async sendReminders(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.prisma.enrollment.findMany({
        where: {
          reminderSentAt: null,
          attempt: null,
          exam: {
            status: 'PUBLISHED',
            startsAt: { gt: now, lte: new Date(now.getTime() + REMINDER_WINDOW_MS) },
          },
        },
        include: {
          student: { select: { email: true, name: true, status: true } },
          exam: { select: { title: true, startsAt: true, durationMinutes: true } },
        },
        take: 200,
      });
      let sent = 0;
      for (const e of due) {
        const claimed = await this.prisma.enrollment.updateMany({
          where: { id: e.id, reminderSentAt: null },
          data: { reminderSentAt: now },
        });
        if (claimed.count === 0 || e.student.status !== 'ACTIVE' || !e.exam.startsAt) continue;
        await this.mail.sendExamReminder(e.student.email, e.student.name, {
          examTitle: e.exam.title,
          startsAt: e.exam.startsAt,
          durationMinutes: e.exam.durationMinutes,
        });
        sent++;
      }
      return sent;
    } catch (err) {
      this.logger.error('Reminder job failed', err as Error);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

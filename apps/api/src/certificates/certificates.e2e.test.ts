import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestContext, createAdmin, createTestApp, signUp } from '../../test/helpers';
import { PublishedExam, auth, joinExam, newStudent, publishExam } from '../../test/scenario';
import { SERIAL_PATTERN } from '@assessiq/shared';
import { CertificatesService } from './certificates.service';
import { buildRawEmail } from '../mail/transports';

type Token = { accessToken: string };

let ctx: TestContext;
let certs: CertificatesService;
let trainer: Token;
let admin: Token;
let sam: Token;
let lee: Token;
let exam: PublishedExam;

beforeAll(async () => {
  ctx = await createTestApp();
  certs = ctx.app.get(CertificatesService);
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await ctx.reset();
  trainer = await signUp(ctx, {
    role: 'EXAMINER',
    email: 'trainer@example.com',
    orgName: 'Asha Academy',
  });
  admin = await createAdmin(ctx);
  sam = await newStudent(ctx, 'sam@example.com');
  lee = await newStudent(ctx, 'lee@example.com');
});

const get = (who: Token, url: string) => ctx.http().get(url).set(auth(who));
const post = (who: Token, url: string, body: object = {}) =>
  ctx.http().post(url).set(auth(who)).send(body);

/** Sam answers everything right (10/10, pass); Lee answers wrongly (0/10, below the pass mark). */
async function sitAndPublish(certificate?: object) {
  exam = await publishExam(ctx, trainer);
  // Most tests are about students, so the trainer's own certificate is off unless asked for.
  await ctx.prisma.exam.update({
    where: { id: exam.examId },
    data: { certificate: { trainerCertificate: false, ...certificate } },
  });
  const q = exam.questionIds;
  const take = async (who: Token, right: boolean) => {
    const enrollmentId = await joinExam(ctx, who, exam.code);
    const a = (await post(who, '/attempts', { enrollmentId }).expect(200)).body;
    const put = (qid: string, body: object) =>
      ctx.http().put(`/attempts/${a.id}/answers/${qid}`).set(auth(who)).send(body).expect(200);
    await put(q.single, { selected: right ? [0] : [1] });
    await put(q.multi, { selected: right ? [0, 1] : [2] });
    if (right) await put(q.subjective, { text: 'The provider secures the cloud itself.' });
    await post(who, `/attempts/${a.id}/submit`).expect(200);
    return a.id as string;
  };
  const samAttempt = await take(sam, true);
  await take(lee, false);
  await ctx
    .http()
    .put(`/exams/${exam.examId}/attempts/${samAttempt}/answers/${q.subjective}/grade`)
    .set(auth(trainer))
    .send({ marks: 5 })
    .expect(200);
  await ctx.prisma.exam.update({
    where: { id: exam.examId },
    data: { endsAt: new Date(Date.now() - 1000) },
  });
  await post(trainer, `/exams/${exam.examId}/finalize`).expect(200);
}

const rows = async (status = 'GENERATED') =>
  (await get(admin, `/admin/certificates?status=${status}`).expect(200)).body as {
    exams: { examId: string; waiting: number; approved: number }[];
    rows: {
      id: string;
      serialNo: string;
      holderName: string;
      kind: string;
      status: string;
      emailBounced: boolean;
    }[];
  };
const certMails = () => ctx.mail.outbox.filter((m) => m.subject.startsWith('Your certificate'));

describe('certificate template', () => {
  beforeEach(async () => {
    exam = await publishExam(ctx, trainer);
  });

  it('starts with sensible defaults and saves changes', async () => {
    const view = (await get(trainer, `/exams/${exam.examId}/certificate`).expect(200)).body;
    expect(view.template).toMatchObject({
      enabled: true,
      participation: true,
      layout: 'CLASSIC',
      accent: 'PURPLE',
    });
    const saved = (
      await ctx
        .http()
        .put(`/exams/${exam.examId}/certificate`)
        .set(auth(trainer))
        .send({
          layout: 'MODERN',
          accent: 'MAROON',
          signatoryName: 'Asha Rao',
          signatoryTitle: 'Director',
          title: 'Cloud Pro',
        })
        .expect(200)
    ).body;
    expect(saved.template).toMatchObject({
      layout: 'MODERN',
      accent: 'MAROON',
      signatoryName: 'Asha Rao',
      title: 'Cloud Pro',
    });
  });

  it('validates, and is only for the trainer who owns the exam', async () => {
    const put = (who: Token, body: object) =>
      ctx.http().put(`/exams/${exam.examId}/certificate`).set(auth(who)).send(body);
    await put(trainer, { accent: 'PINK' }).expect(400);
    await put(trainer, { layout: 'FANCY' }).expect(400);
    await put(trainer, { title: 'x'.repeat(61) }).expect(400);
    const other = await signUp(ctx, { role: 'EXAMINER', email: 'other@example.com' });
    await put(other, {}).expect(404);
    await put(sam, {}).expect(403);
    await get(other, `/exams/${exam.examId}/certificate`).expect(404);
  });

  it('previews a real PDF, for both kinds and both layouts, even with unusual text', async () => {
    const preview = (body: object, kind = '') =>
      ctx
        .http()
        .post(`/exams/${exam.examId}/certificate/preview${kind}`)
        .set(auth(trainer))
        .send(body)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
    for (const layout of ['CLASSIC', 'MODERN']) {
      const res = await preview(
        { layout, signatoryName: 'Asha Rao – परीक्षक' },
        '?kind=PARTICIPATION',
      ).expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((res.body as Buffer).length).toBeGreaterThan(5_000);
    }
    await preview({}).expect(200);
    await ctx
      .http()
      .post(`/exams/${exam.examId}/certificate/preview`)
      .set(auth(sam))
      .send({})
      .expect(403);
  });
});

describe('after results are published', () => {
  it('makes one certificate per student: achievement above the pass mark, participation below', async () => {
    await sitAndPublish();
    const q = await rows();
    expect(q.rows).toHaveLength(2);
    const byName = Object.fromEntries(q.rows.map((r) => [r.holderName, r]));
    expect(byName['Sam Student']).toBeTruthy();
    const kinds = q.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['ACHIEVEMENT', 'PARTICIPATION']);
    for (const r of q.rows) {
      expect(r.serialNo).toMatch(SERIAL_PATTERN);
      expect(r.status).toBe('GENERATED');
    }
    expect(q.exams[0]).toMatchObject({ examId: exam.examId, waiting: 2, approved: 0 });
  });

  it('can skip students below the pass mark', async () => {
    await sitAndPublish({ participation: false });
    const q = await rows();
    expect(q.rows.map((r) => r.holderName)).toEqual(['Sam Student']);
    expect(q.rows[0].kind).toBe('ACHIEVEMENT');
  });

  it('makes none when the trainer turned certificates off', async () => {
    await sitAndPublish({ enabled: false });
    expect((await rows()).rows).toHaveLength(0);
  });

  it('is locked once results are published', async () => {
    await sitAndPublish();
    await ctx
      .http()
      .put(`/exams/${exam.examId}/certificate`)
      .set(auth(trainer))
      .send({ accent: 'GREEN' })
      .expect(409);
    const view = (await get(trainer, `/exams/${exam.examId}/certificate`).expect(200)).body;
    expect(view).toMatchObject({ finalized: true, total: 2, waiting: 2, issued: 0 });
  });

  it('never emails or releases anything before an admin approves', async () => {
    await sitAndPublish();
    const run = await certs.runOnce();
    expect(run.generated).toBe(2); // the PDFs are made...
    expect(run.emailed).toBe(0); // ...but nothing is sent
    expect(certMails()).toHaveLength(0);

    const mine = (await get(sam, '/certificates/mine').expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0].state).toBe('PENDING');
    const id = (
      await ctx.prisma.certificate.findFirstOrThrow({
        where: { student: { email: 'sam@example.com' } },
      })
    ).id;
    await get(sam, `/certificates/${id}/pdf`).expect(404);
    // a trainer's list holds their own certificates only (none here, since it is off)
    expect((await get(trainer, '/certificates/mine').expect(200)).body).toHaveLength(0);
  });
});

describe("the trainer's certificate", () => {
  beforeEach(async () => {
    await sitAndPublish({ trainerCertificate: true });
  });

  it('makes one Certificate of Appreciation for the trainer, next to the students’ ones', async () => {
    const q = await rows();
    expect(q.rows).toHaveLength(3);
    const mine = q.rows.find((r) => r.kind === 'TRAINER')!;
    expect(mine).toMatchObject({
      holderName: 'Test User',
      holderEmail: 'trainer@example.com',
      status: 'GENERATED',
    });
    expect((mine as unknown as { participants: number }).participants).toBe(2);
    expect(mine.serialNo).toMatch(SERIAL_PATTERN);
    expect(q.rows.filter((r) => r.kind !== 'TRAINER')).toHaveLength(2);
    // only ever one per exam, even if publishing is run again
    expect(await certs.createForExam(exam.examId)).toBe(0);
    expect((await rows()).rows).toHaveLength(3);
  });

  it('follows the same rules: nothing before approval, then email and download for the trainer', async () => {
    await certs.runOnce();
    expect(certMails()).toHaveLength(0);
    const waiting = (await get(trainer, '/certificates/mine').expect(200)).body;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: 'TRAINER', state: 'PENDING' });
    await get(trainer, `/certificates/${waiting[0].id}/pdf`).expect(404);

    const id = (await rows()).rows.find((r) => r.kind === 'TRAINER')!.id;
    await post(admin, '/admin/certificates/approve', { ids: [id] }).expect(200);
    await certs.runOnce();
    const mails = certMails();
    expect(mails.map((m) => m.to)).toEqual(['trainer@example.com']);
    expect(mails[0].attachments![0].content.subarray(0, 5).toString()).toBe('%PDF-');

    const issued = (await get(trainer, '/certificates/mine').expect(200)).body;
    expect(issued[0].state).toBe('ISSUED');
    await get(trainer, `/certificates/${issued[0].id}/pdf`).expect(200);
    // nobody else can open it
    await get(sam, `/certificates/${issued[0].id}/pdf`).expect(404);
    await get(sam, '/certificates/mine').expect(200);
  });

  it('is public-checkable and shows as an Appreciation certificate', async () => {
    const t = await ctx.prisma.certificate.findFirstOrThrow({ where: { kind: 'TRAINER' } });
    await post(admin, '/admin/certificates/approve', { ids: [t.id] }).expect(200);
    const res = (await ctx.http().get(`/verify/${t.serialNo}`).expect(200)).body;
    expect(res).toMatchObject({ state: 'VALID', kind: 'TRAINER', holderName: 'Test User' });
    expect(JSON.stringify(res)).not.toContain('trainer@example.com');
  });

  it('can be turned off, and the preview can draw it', async () => {
    const tpl = { trainerCertificate: false };
    await ctx
      .http()
      .put(`/exams/${exam.examId}/certificate`)
      .set(auth(trainer))
      .send(tpl)
      .expect(409); // locked now
    const res = await ctx
      .http()
      .post(`/exams/${exam.examId}/certificate/preview?kind=TRAINER`)
      .set(auth(trainer))
      .send({})
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('admin approval and email', () => {
  beforeEach(async () => {
    await sitAndPublish();
  });

  it('shows the queue, previews the PDF and is only for admins', async () => {
    await get(trainer, '/admin/certificates').expect(403);
    await get(sam, '/admin/certificates').expect(403);
    await ctx.http().get('/admin/certificates').expect(401);
    const q = await rows();
    const res = await get(admin, `/admin/certificates/${q.rows[0].id}/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('approves a whole exam at once, emails each student the PDF and lets them download it', async () => {
    const res = await post(admin, '/admin/certificates/approve', { examId: exam.examId }).expect(
      200,
    );
    expect(res.body.approved).toBe(2);
    expect(certMails()).toHaveLength(0); // sending happens in the background job
    const run = await certs.runOnce();
    expect(run.emailed).toBe(2);

    const mails = certMails();
    expect(mails.map((m) => m.to).sort()).toEqual(['lee@example.com', 'sam@example.com']);
    const att = mails[0].attachments![0];
    expect(att.filename).toMatch(/^certificate-AIQ-/);
    expect(att.contentType).toBe('application/pdf');
    expect(att.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(mails[0].text).toContain('https://assessiq.nandivex.in/verify/?serial=AIQ-');

    expect((await rows('EMAILED')).rows).toHaveLength(2);
    const mine = (await get(sam, '/certificates/mine').expect(200)).body;
    expect(mine[0].state).toBe('ISSUED');
    const dl = await get(sam, `/certificates/${mine[0].id}/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((dl.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    // another student cannot download it
    await get(lee, `/certificates/${mine[0].id}/pdf`).expect(404);

    // a second run has nothing left to send
    expect((await certs.runOnce()).emailed).toBe(0);
  });

  it('approves chosen certificates only', async () => {
    const q = await rows();
    await post(admin, '/admin/certificates/approve', {}).expect(400);
    await post(admin, '/admin/certificates/approve', { ids: [q.rows[0].id] }).expect(200);
    await certs.runOnce();
    expect(certMails()).toHaveLength(1);
    expect((await rows()).rows).toHaveLength(1);
  });

  it('rejects with a reason, hides it from the student and never emails it', async () => {
    const lees = await ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'lee@example.com' } },
    });
    await post(admin, '/admin/certificates/reject', { ids: [lees.id], reason: 'x' }).expect(400);
    await post(admin, '/admin/certificates/reject', {
      ids: [lees.id],
      reason: 'Cheating suspected',
    }).expect(200);
    // approving the whole exam leaves the rejected one alone
    const res = await post(admin, '/admin/certificates/approve', { examId: exam.examId }).expect(
      200,
    );
    expect(res.body.approved).toBe(1);
    await certs.runOnce();
    expect(certMails().map((m) => m.to)).toEqual(['sam@example.com']);
    const rejected = (await rows('REJECTED')).rows;
    expect(rejected.map((r) => r.id)).toEqual([lees.id]);
    expect(
      (await ctx.prisma.certificate.findUniqueOrThrow({ where: { id: lees.id } })).rejectReason,
    ).toBe('Cheating suspected');
    expect((await get(lee, '/certificates/mine').expect(200)).body).toHaveLength(0);
    await get(lee, `/certificates/${lees.id}/pdf`).expect(404);
    // an admin can change their mind by choosing it explicitly
    await post(admin, '/admin/certificates/approve', { ids: [lees.id] }).expect(200);
    await certs.runOnce();
    expect(certMails()).toHaveLength(2);
  });

  it('retries an email that failed, with a pause, and gives up after five tries', async () => {
    await post(admin, '/admin/certificates/approve', { examId: exam.examId }).expect(200);
    const spy = vi.spyOn(ctx.mail, 'send').mockRejectedValue(new Error('SES is down'));
    expect((await certs.runOnce()).emailed).toBe(0);
    spy.mockRestore();
    let c = await ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'sam@example.com' } },
    });
    expect(c.status).toBe('APPROVED');
    expect(c.emailAttempts).toBe(1);
    expect(c.emailError).toContain('SES is down');
    expect(c.emailNextAt!.getTime()).toBeGreaterThan(Date.now());
    // paused: nothing is sent until the retry time
    expect((await certs.runOnce()).emailed).toBe(0);
    await ctx.prisma.certificate.updateMany({ data: { emailNextAt: null } });
    expect((await certs.runOnce()).emailed).toBe(2);
    c = await ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'sam@example.com' } },
    });
    expect(c.status).toBe('EMAILED');

    // five failures in a row stop the retries (an admin can resend)
    const id = c.id;
    await ctx.prisma.certificate.update({
      where: { id },
      data: { status: 'APPROVED', emailAttempts: 5, emailNextAt: null },
    });
    ctx.mail.clear();
    expect((await certs.runOnce()).emailed).toBe(0);
  });

  it('can resend an issued certificate', async () => {
    await post(admin, '/admin/certificates/approve', { examId: exam.examId }).expect(200);
    await certs.runOnce();
    ctx.mail.clear();
    const id = (await rows('EMAILED')).rows[0].id;
    await post(trainer, `/admin/certificates/${id}/resend`).expect(403);
    await post(admin, `/admin/certificates/${id}/resend`).expect(200);
    expect((await certs.runOnce()).emailed).toBe(1);
    expect(certMails()).toHaveLength(1);
    // a certificate that was never approved cannot be sent
    await ctx.prisma.certificate.update({ where: { id }, data: { status: 'GENERATED' } });
    await post(admin, `/admin/certificates/${id}/resend`).expect(409);
    await post(admin, '/admin/certificates/00000000-0000-0000-0000-000000000000/resend').expect(
      404,
    );
  });
});

describe('public verification', () => {
  const verify = (serial: string) => ctx.http().get(`/verify/${encodeURIComponent(serial)}`);

  beforeEach(async () => {
    await sitAndPublish();
  });

  it('confirms an issued certificate with the holder, exam and date, and nothing private', async () => {
    const q = await rows();
    const sams = await ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'sam@example.com' } },
    });
    expect(q.rows.length).toBe(2);
    // not yet approved: it does not exist as far as the public is concerned
    expect((await verify(sams.serialNo).expect(200)).body.state).toBe('NOT_FOUND');

    await post(admin, '/admin/certificates/approve', { ids: [sams.id] }).expect(200);
    const res = (await verify(sams.serialNo.toLowerCase()).expect(200)).body; // no sign-in needed
    expect(res).toMatchObject({
      state: 'VALID',
      holderName: 'Sam Student',
      examTitle: 'Cloud Fundamentals',
      kind: 'ACHIEVEMENT',
    });
    expect(res.organisation).toBeTruthy();
    const raw = JSON.stringify(res);
    expect(raw).not.toContain('sam@example.com');
    expect(raw).not.toContain('scorePercent');
    expect(raw).not.toContain('100');
  });

  it('says not found for unknown, malformed and tampered serials', async () => {
    expect((await verify('AIQ-AAAA-BBBB-CCCC').expect(200)).body.state).toBe('NOT_FOUND');
    expect((await verify('nonsense').expect(200)).body.state).toBe('NOT_FOUND');
    expect((await verify("AIQ-'; DROP TABLE").expect(200)).body.state).toBe('NOT_FOUND');
    const c = await ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'sam@example.com' } },
    });
    await post(admin, '/admin/certificates/approve', { ids: [c.id] }).expect(200);
    expect((await verify(c.serialNo).expect(200)).body.state).toBe('VALID');
    // someone edits the name in the database: the signature no longer matches
    await ctx.prisma.certificate.update({
      where: { id: c.id },
      data: { holderName: 'Someone Else' },
    });
    expect((await verify(c.serialNo).expect(200)).body.state).toBe('NOT_FOUND');
  });

  it('shows a certificate as revoked after it was issued and then rejected', async () => {
    const c = await ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'sam@example.com' } },
    });
    await post(admin, '/admin/certificates/approve', { ids: [c.id] }).expect(200);
    await post(admin, '/admin/certificates/reject', {
      ids: [c.id],
      reason: 'Issued by mistake',
    }).expect(200);
    const res = (await verify(c.serialNo).expect(200)).body;
    expect(res.state).toBe('REVOKED');
    expect(JSON.stringify(res)).not.toContain('mistake');
    // a certificate that was rejected before ever being issued stays invisible
    const other = await ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'lee@example.com' } },
    });
    await post(admin, '/admin/certificates/reject', {
      ids: [other.id],
      reason: 'No' + ' thanks',
    }).expect(200);
    expect((await verify(other.serialNo).expect(200)).body.state).toBe('NOT_FOUND');
  });
});

describe('mail bounce notices', () => {
  const KEY = 'test-ses-events-key-0123456789';
  const notice = (key: string | undefined, type: string, body: object) =>
    ctx
      .http()
      .post(`/mail/ses-events${key ? `?key=${key}` : ''}`)
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .set('x-amz-sns-message-type', type)
      .send(JSON.stringify(body));

  async function issue() {
    await sitAndPublish();
    await post(admin, '/admin/certificates/approve', { examId: exam.examId }).expect(200);
    await certs.runOnce();
    return ctx.prisma.certificate.findFirstOrThrow({
      where: { student: { email: 'sam@example.com' } },
    });
  }
  const bounce = (messageId: string, snsId = 'sns-1') => ({
    MessageId: snsId,
    Message: JSON.stringify({
      eventType: 'Bounce',
      mail: { messageId },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'sam@example.com' }] },
    }),
  });

  it('marks the certificate when its email bounced, once, and the admin can see and resend it', async () => {
    const c = await issue();
    expect(c.emailMessageId).toBeTruthy();
    await notice(KEY, 'Notification', bounce(c.emailMessageId!)).expect(200);
    await notice(KEY, 'Notification', bounce(c.emailMessageId!)).expect(200); // redelivery
    const after = await ctx.prisma.certificate.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.emailBouncedAt).toBeTruthy();
    expect(after.emailError).toContain('Bounced');
    expect(await ctx.prisma.emailEvent.count()).toBe(1);
    const row = (await rows('EMAILED')).rows.find((r) => r.id === c.id)!;
    expect(row.emailBounced).toBe(true);
    await post(admin, `/admin/certificates/${c.id}/resend`).expect(200);
    expect(
      (await ctx.prisma.certificate.findUniqueOrThrow({ where: { id: c.id } })).emailBouncedAt,
    ).toBeNull();
  });

  it('ignores deliveries for other mail, and rejects a wrong or missing key', async () => {
    const c = await issue();
    await notice(KEY, 'Notification', {
      MessageId: 'sns-2',
      Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: c.emailMessageId } }),
    }).expect(200);
    expect(
      (await ctx.prisma.certificate.findUniqueOrThrow({ where: { id: c.id } })).emailBouncedAt,
    ).toBeNull();
    await notice(KEY, 'Notification', bounce('someone-elses-mail', 'sns-3')).expect(200);
    expect(
      (await ctx.prisma.certificate.findUniqueOrThrow({ where: { id: c.id } })).emailBouncedAt,
    ).toBeNull();
    await notice(
      'wrong-key-wrong-key-wrong',
      'Notification',
      bounce(c.emailMessageId!, 'sns-4'),
    ).expect(404);
    await notice(undefined, 'Notification', bounce(c.emailMessageId!, 'sns-5')).expect(404);
  });

  it('only confirms a subscription with AWS itself', async () => {
    await notice(KEY, 'SubscriptionConfirmation', {
      MessageId: 'sns-6',
      SubscribeURL: 'https://evil.example.com/confirm',
    }).expect(400);
    await notice(KEY, 'SubscriptionConfirmation', {
      MessageId: 'sns-7',
      SubscribeURL: 'http://sns.ap-south-1.amazonaws.com/confirm',
    }).expect(400);
  });
});

describe('raw email', () => {
  it('builds a multipart message with the PDF attached', () => {
    const raw = buildRawEmail('AssessIQ <no-reply@assessiq.nandivex.in>', {
      to: 'sam@example.com',
      subject: 'Your certificate – ready',
      text: 'Hello',
      html: '<p>Hello</p>',
      attachments: [
        {
          filename: 'my cert (1).pdf',
          contentType: 'application/pdf',
          content: Buffer.from('%PDF-1.7 test'),
        },
      ],
    }).toString('utf8');
    expect(raw).toContain('Content-Type: multipart/mixed');
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Content-Disposition: attachment; filename="my_cert__1_.pdf"');
    expect(raw).toContain(Buffer.from('%PDF-1.7 test').toString('base64'));
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/); // non-ASCII subject is encoded
    expect(raw.endsWith('--\r\n')).toBe(true);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createAdmin, createTestApp, signUp } from '../../test/helpers';
import { PublishedExam, auth, joinExam, newStudent, publishExam } from '../../test/scenario';

let ctx: TestContext;
let trainer: { accessToken: string };
let admin: { accessToken: string };
let exam: PublishedExam;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await ctx.reset();
  trainer = await signUp(ctx, { role: 'EXAMINER', email: 'trainer@example.com' });
  const a = await createAdmin(ctx);
  admin = { accessToken: a.accessToken };
  exam = await publishExam(ctx, trainer);
});

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const post = (url: string, who: { accessToken: string }, body: object = {}) =>
  ctx.http().post(url).set(auth(who)).send(body);

describe('extend', () => {
  it('moves the closing time later, never earlier', async () => {
    await post(`/exams/${exam.examId}/extend`, trainer, { endsAt: hours(5) }).expect(200);
    const row = await ctx.prisma.exam.findUnique({ where: { id: exam.examId } });
    expect(row!.endsAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 3_600_000);
    await post(`/exams/${exam.examId}/extend`, trainer, { endsAt: hours(2) }).expect(409);
  });

  it("is only for the exam's own trainer", async () => {
    const other = await signUp(ctx, { role: 'EXAMINER', email: 'other@example.com' });
    await post(`/exams/${exam.examId}/extend`, other, { endsAt: hours(5) }).expect(404);
  });
});

describe('close', () => {
  it('stops new students from joining and starting, and reports who is still sitting', async () => {
    const sam = await newStudent(ctx, 'sam@example.com');
    const enrollmentId = await joinExam(ctx, sam, exam.code);
    await ctx.http().post('/attempts').set(auth(sam)).send({ enrollmentId }).expect(200);

    const res = await post(`/exams/${exam.examId}/close`, trainer).expect(200);
    expect(res.body.stillRunning).toBe(1);

    const lena = await newStudent(ctx, 'lena@example.com');
    await ctx.http().post(`/join/${exam.code}/order`).set(auth(lena)).expect(409);
    await post(`/exams/${exam.examId}/close`, trainer).expect(409); // already closed
  });
});

describe('cancel', () => {
  it('refunds every student who has not started, keeps the publishing fee, and blocks joining', async () => {
    const sam = await newStudent(ctx, 'sam@example.com');
    const lena = await newStudent(ctx, 'lena@example.com');
    await joinExam(ctx, sam, exam.code);
    await joinExam(ctx, lena, exam.code);

    const res = await post(`/exams/${exam.examId}/cancel`, trainer, {
      reason: 'Venue unavailable',
    }).expect(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', refunded: 2, notRefunded: [] });

    expect(
      await ctx.prisma.payment.count({ where: { examId: exam.examId, status: 'REFUNDED' } }),
    ).toBe(2);
    expect(
      (
        await ctx.prisma.payment.findFirst({
          where: { examId: exam.examId, purpose: 'EXAM_CREATION' },
        })
      )?.status,
    ).toBe('CAPTURED');
    expect(await ctx.prisma.enrollment.count({ where: { examId: exam.examId } })).toBe(0);
    expect((await ctx.prisma.exam.findUnique({ where: { id: exam.examId } }))?.status).toBe(
      'CANCELLED',
    );

    const late = await newStudent(ctx, 'late@example.com');
    await ctx.http().post(`/join/${exam.code}/order`).set(auth(late)).expect(404);
    await post(`/exams/${exam.examId}/cancel`, trainer, { reason: 'Again please' }).expect(409);
  });

  it('refuses once someone has started, unless forced; the started student is not refunded', async () => {
    const sam = await newStudent(ctx, 'sam@example.com');
    const lena = await newStudent(ctx, 'lena@example.com');
    const enrollmentId = await joinExam(ctx, sam, exam.code);
    await joinExam(ctx, lena, exam.code);
    await ctx.http().post('/attempts').set(auth(sam)).send({ enrollmentId }).expect(200);

    await post(`/exams/${exam.examId}/cancel`, trainer, { reason: 'Something came up' }).expect(
      409,
    );
    const res = await post(`/exams/${exam.examId}/cancel`, trainer, {
      reason: 'Something came up',
      force: true,
    }).expect(200);
    expect(res.body.refunded).toBe(1);
    expect(res.body.notRefunded).toHaveLength(1);
  });

  it('needs a written reason', async () => {
    await post(`/exams/${exam.examId}/cancel`, trainer, { reason: 'no' }).expect(400);
  });
});

describe('admin suspend', () => {
  it("stops another trainer's exam and refunds students; trainers cannot use it", async () => {
    const sam = await newStudent(ctx, 'sam@example.com');
    await joinExam(ctx, sam, exam.code);
    await post(`/admin/exams/${exam.examId}/suspend`, trainer, { reason: 'Fraud report' }).expect(
      403,
    );
    const res = await post(`/admin/exams/${exam.examId}/suspend`, admin, {
      reason: 'Fraud report confirmed',
    }).expect(200);
    expect(res.body.refunded).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'exam.suspend' } })).toBe(1);
  });
});

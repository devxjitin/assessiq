import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createAdmin, createTestApp, signUp } from '../../test/helpers';
import { PublishedExam, auth, joinExam, newStudent, publishExam } from '../../test/scenario';

type Token = { accessToken: string };

let ctx: TestContext;
let trainer: Token;
let admin: Token;
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
  admin = await createAdmin(ctx);
  exam = await publishExam(ctx, trainer);
});

const get = (who: Token, url: string) => ctx.http().get(url).set(auth(who));
const post = (who: Token, url: string, body: object = {}) =>
  ctx.http().post(url).set(auth(who)).send(body);

describe('my payments', () => {
  it('lists only my own paid payments with a receipt, for trainers and students', async () => {
    const sam = await newStudent(ctx, 'sam@example.com');
    await joinExam(ctx, sam, exam.code);
    const lee = await newStudent(ctx, 'lee@example.com');
    await joinExam(ctx, lee, exam.code);

    const mine = (await get(sam, '/me/payments').expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      purpose: 'EXAM_JOIN',
      description: 'Exam fee',
      status: 'CAPTURED',
      amountPaise: 14_900,
      examTitle: 'Cloud Fundamentals',
      canRequestRefund: true,
      refundRequest: null,
    });
    expect(mine[0].receiptNo).toMatch(/^PRK-R-\d+$/);

    const receipt = (await get(sam, `/me/payments/${mine[0].id}`).expect(200)).body;
    expect(receipt).toMatchObject({ payerEmail: 'sam@example.com', payerName: 'Sam Student' });
    expect(receipt.note).toMatch(/not a GST tax invoice/);

    // Someone else's receipt looks like it does not exist.
    await get(lee, `/me/payments/${mine[0].id}`).expect(404);
    await get(lee, '/me/payments/not-a-uuid').expect(404);

    // The trainer sees the creation fee they paid, not their students' fees.
    const theirs = (await get(trainer, '/me/payments').expect(200)).body;
    expect(theirs.map((p: { purpose: string }) => p.purpose)).toEqual(['EXAM_CREATION']);
    await get(admin, '/me/payments').expect(403);
  });
});

describe('student refund requests', () => {
  async function joined() {
    const sam = await newStudent(ctx, 'sam@example.com');
    const enrollmentId = await joinExam(ctx, sam, exam.code);
    const payment = (await get(sam, '/me/payments').expect(200)).body[0];
    return { sam, enrollmentId, payment };
  }

  it('is approved by an admin: the money goes back and the seat is freed', async () => {
    const { sam, payment } = await joined();
    ctx.mail.clear();
    const after = (
      await post(sam, `/me/payments/${payment.id}/refund-request`, {
        reason: 'Clash with work',
      }).expect(200)
    ).body;
    expect(after.refundRequest).toMatchObject({ status: 'REQUESTED', reason: 'Clash with work' });
    expect(after.canRequestRefund).toBe(false);
    expect(ctx.mail.outbox.some((m) => /Refund request/.test(m.subject))).toBe(true);
    await post(sam, `/me/payments/${payment.id}/refund-request`, { reason: 'Again please' }).expect(
      409,
    );

    const queue = (await get(admin, '/admin/finance/refund-requests?status=REQUESTED').expect(200))
      .body;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      studentEmail: 'sam@example.com',
      amountPaise: 14_900,
      reason: 'Clash with work',
      stillEligible: true,
    });

    await post(admin, `/admin/finance/refund-requests/${queue[0].id}/approve`).expect(200);
    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('REFUNDED');
    expect(await ctx.prisma.enrollment.count({ where: { examId: exam.examId } })).toBe(0);
    expect(ctx.mail.lastTo('sam@example.com')?.subject).toMatch(/Refund of INR/);
    await post(admin, `/admin/finance/refund-requests/${queue[0].id}/approve`).expect(409);

    const mine = (await get(sam, '/me/payments').expect(200)).body[0];
    expect(mine).toMatchObject({ status: 'REFUNDED', refundRequest: { status: 'APPROVED' } });
  });

  it('can be rejected with a reason the student is emailed', async () => {
    const { sam, payment } = await joined();
    await post(sam, `/me/payments/${payment.id}/refund-request`, {
      reason: 'Changed my mind',
    }).expect(200);
    const [req] = (await get(admin, '/admin/finance/refund-requests').expect(200)).body;
    await post(admin, `/admin/finance/refund-requests/${req.id}/reject`, { note: 'x' }).expect(400);
    ctx.mail.clear();
    await post(admin, `/admin/finance/refund-requests/${req.id}/reject`, {
      note: 'Fee is not refundable after joining',
    }).expect(200);
    expect(ctx.mail.lastTo('sam@example.com')?.text).toContain('Fee is not refundable');
    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('CAPTURED');
    await post(admin, `/admin/finance/refund-requests/${req.id}/reject`, {
      note: 'Fee is not refundable after joining',
    }).expect(409);
    // One request per payment: a rejected student cannot ask again.
    await post(sam, `/me/payments/${payment.id}/refund-request`, {
      reason: 'Please reconsider',
    }).expect(409);
  });

  it('is refused once the student has started the exam, and cannot be approved after that either', async () => {
    const { sam, enrollmentId, payment } = await joined();
    await post(sam, `/me/payments/${payment.id}/refund-request`, { reason: 'Maybe later' }).expect(
      200,
    );
    await post(sam, '/attempts', { enrollmentId }).expect(200);

    const [req] = (await get(admin, '/admin/finance/refund-requests').expect(200)).body;
    expect(req.stillEligible).toBe(false);
    await post(admin, `/admin/finance/refund-requests/${req.id}/approve`).expect(409);
    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('CAPTURED'); // the money stays, and the request stays open

    const lee = await newStudent(ctx, 'lee@example.com');
    const leeEnrollment = await joinExam(ctx, lee, exam.code);
    await post(lee, '/attempts', { enrollmentId: leeEnrollment }).expect(200);
    const leePay = (await get(lee, '/me/payments').expect(200)).body[0];
    expect(leePay.canRequestRefund).toBe(false);
    await post(lee, `/me/payments/${leePay.id}/refund-request`, { reason: 'Too hard' }).expect(409);
  });

  it('is not available for a trainer or someone else’s payment, and the queue is admin-only', async () => {
    const { sam, payment } = await joined();
    const lee = await newStudent(ctx, 'lee@example.com');
    await post(lee, `/me/payments/${payment.id}/refund-request`, { reason: 'Not mine' }).expect(
      404,
    );
    await post(sam, `/me/payments/${payment.id}/refund-request`, { reason: 'Need it back' }).expect(200);
    await get(sam, '/admin/finance/refund-requests').expect(403);
    await get(trainer, '/admin/finance/refund-requests').expect(403);

    const creation = (await get(trainer, '/me/payments').expect(200)).body[0];
    expect(creation.canRequestRefund).toBe(false);
    await post(trainer, `/me/payments/${creation.id}/refund-request`, {
      reason: 'Refund me',
    }).expect(409);
  });
});

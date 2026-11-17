import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createTestApp, signUp } from '../../test/helpers';
import { auth, joinExam, newStudent, publishExam } from '../../test/scenario';
import { FakePaymentProvider } from '../payments/provider';

let ctx: TestContext;
let trainer: { accessToken: string };
let sam: { accessToken: string };

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await ctx.reset();
  trainer = await signUp(ctx, { role: 'EXAMINER', email: 'trainer@example.com' });
  sam = await newStudent(ctx, 'sam@example.com');
});

describe('looking up a code', () => {
  it('is for signed-in students and hides unknown codes', async () => {
    const { code } = await publishExam(ctx, trainer);
    await ctx.http().get(`/join/${code}`).expect(401);
    await ctx.http().get(`/join/${code}`).set(auth(trainer)).expect(403);
    await ctx.http().get('/join/NVX-ZZZZZZ').set(auth(sam)).expect(404);
  });

  it('shows the exam, the fee and the state, and forgives how the code is typed', async () => {
    const { code } = await publishExam(ctx, trainer);
    const res = await ctx.http().get(`/join/${code}`).set(auth(sam)).expect(200);
    expect(res.body).toMatchObject({
      title: 'Cloud Fundamentals',
      feePaise: 14900,
      questionCount: 3,
      totalMarks: 10,
      state: 'OPEN',
    });
    const sloppy = code.toLowerCase().replace('-', ' ');
    await ctx
      .http()
      .get(`/join/${encodeURIComponent(sloppy)}`)
      .set(auth(sam))
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain('correctOptions');
  });

  it('reports NOT_STARTED, ENDED and FULL', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 7_200_000).toISOString();
    const future = await publishExam(ctx, trainer, { startsAt: soon, endsAt: later });
    expect(
      (await ctx.http().get(`/join/${future.code}`).set(auth(sam)).expect(200)).body.state,
    ).toBe('NOT_STARTED');

    const ended = await publishExam(ctx, trainer);
    await ctx.prisma.exam.update({
      where: { id: ended.examId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await ctx.http().get(`/join/${ended.code}`).set(auth(sam)).expect(200)).body.state,
    ).toBe('ENDED');

    const tiny = await publishExam(ctx, trainer, { maxStudents: 1 });
    await joinExam(ctx, sam, tiny.code);
    const other = await newStudent(ctx, 'other@example.com');
    expect(
      (await ctx.http().get(`/join/${tiny.code}`).set(auth(other)).expect(200)).body.state,
    ).toBe('FULL');
  });
});

describe('joining', () => {
  it('takes the 149 rupee fee, enrolls the student and emails a receipt', async () => {
    const { code, examId } = await publishExam(ctx, trainer);
    const order = (await ctx.http().post(`/join/${code}/order`).set(auth(sam)).expect(200)).body;
    expect(order).toMatchObject({ amountPaise: 14900, provider: 'fake' });

    const enrollmentId = await joinExam(ctx, sam, code);
    const row = await ctx.prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    expect(row).toMatchObject({ examId });

    const mails = ctx.mail.outbox.filter(
      (m) => m.to === 'sam@example.com' && m.subject.includes('Receipt'),
    );
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain('INR 149.00');

    const list = await ctx.http().get('/me/enrollments').set(auth(sam)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ enrollmentId, canStart: true, attempt: null });
  });

  it('refuses a second join, an ended exam and an unknown code', async () => {
    const { code, examId } = await publishExam(ctx, trainer);
    await joinExam(ctx, sam, code);
    await ctx.http().post(`/join/${code}/order`).set(auth(sam)).expect(409);

    const other = await newStudent(ctx, 'other@example.com');
    await ctx.prisma.exam.update({
      where: { id: examId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    await ctx.http().post(`/join/${code}/order`).set(auth(other)).expect(409);
    await ctx.http().post('/join/NVX-ZZZZZZ/order').set(auth(other)).expect(404);
    await ctx.http().post(`/join/${code}/order`).set(auth(trainer)).expect(403);
  });

  it('resumes an unpaid order instead of creating another', async () => {
    const { code } = await publishExam(ctx, trainer);
    const a = (await ctx.http().post(`/join/${code}/order`).set(auth(sam)).expect(200)).body;
    const b = (await ctx.http().post(`/join/${code}/order`).set(auth(sam)).expect(200)).body;
    expect(b.orderId).toBe(a.orderId);
  });

  it("does not let one student settle another student's order", async () => {
    const { code } = await publishExam(ctx, trainer);
    const order = (await ctx.http().post(`/join/${code}/order`).set(auth(sam)).expect(200)).body;
    const other = await newStudent(ctx, 'other@example.com');
    await ctx
      .http()
      .post('/payments/fake/complete')
      .set(auth(other))
      .send({ orderId: order.orderId })
      .expect(404);
  });

  it('flags for refund when the last seat is taken between order and payment', async () => {
    const { code } = await publishExam(ctx, trainer, { maxStudents: 1 });
    const other = await newStudent(ctx, 'other@example.com');
    // Both start paying while a seat is free...
    const sOrder = (await ctx.http().post(`/join/${code}/order`).set(auth(sam)).expect(200)).body;
    const oOrder = (await ctx.http().post(`/join/${code}/order`).set(auth(other)).expect(200)).body;
    const pay = async (who: { accessToken: string }, orderId: string) =>
      (
        await ctx
          .http()
          .post('/payments/fake/complete')
          .set(auth(who))
          .send({ orderId })
          .expect(200)
      ).body;
    // ...Sam finishes first, so the other student's paid order has no seat.
    await ctx
      .http()
      .post('/payments/verify')
      .set(auth(sam))
      .send(await pay(sam, sOrder.orderId))
      .expect(200);
    await ctx
      .http()
      .post('/payments/verify')
      .set(auth(other))
      .send(await pay(other, oOrder.orderId))
      .expect(409);

    expect(await ctx.prisma.enrollment.count()).toBe(1);
    const orphan = await ctx.prisma.auditLog.findFirst({ where: { action: 'payment.orphan' } });
    expect(orphan?.meta).toMatchObject({ reason: 'FULL' });
  });

  it('also enrolls from a webhook when the browser never reports back', async () => {
    const { code, examId } = await publishExam(ctx, trainer);
    const order = (await ctx.http().post(`/join/${code}/order`).set(auth(sam)).expect(200)).body;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_j', order_id: order.orderId, amount: 14900 } } },
    });
    await ctx
      .http()
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-event-id', 'evt_join')
      .set('x-razorpay-signature', FakePaymentProvider.signWebhook(body))
      .send(body)
      .expect(200);
    expect(await ctx.prisma.enrollment.count({ where: { examId } })).toBe(1);
  });
});

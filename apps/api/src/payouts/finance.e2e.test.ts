import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createAdmin, createTestApp, signUp } from '../../test/helpers';
import { PublishedExam, auth, joinExam, newStudent, publishExam } from '../../test/scenario';

type Token = { accessToken: string };

let ctx: TestContext;
let trainer: Token;
let admin: Token;
let exam: PublishedExam;
let trainerId: string;

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
  trainerId = (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'trainer@example.com' } }))
    .id;
  exam = await publishExam(ctx, trainer);
});

const get = (who: Token, url: string) => ctx.http().get(url).set(auth(who));
const post = (who: Token, url: string, body: object = {}) =>
  ctx.http().post(url).set(auth(who)).send(body);
const earnings = async () => (await get(trainer, '/earnings').expect(200)).body;
const ledger = async () => (await get(admin, '/admin/finance/ledger').expect(200)).body;

/** n students pay the join fee. Returns their tokens. */
async function students(n: number, prefix = 'stu') {
  const out: Token[] = [];
  for (let i = 0; i < n; i++) {
    const s = await newStudent(ctx, `${prefix}${i}@example.com`);
    await joinExam(ctx, s, exam.code);
    out.push(s);
  }
  return out;
}

/** The exam's results are published: the trainer's share becomes payable. */
const publishResults = () =>
  ctx.prisma.exam.update({ where: { id: exam.examId }, data: { status: 'RESULTS_FINAL' } });

const UPI = { method: 'UPI', upiId: 'trainer@okbank' };
const BANK = {
  method: 'BANK',
  accountName: 'Asha Rao',
  accountNumber: '123456789012',
  ifsc: 'hdfc0001234',
};

describe('ledger', () => {
  it('books the creation fee and splits each join fee 50/50, always balancing to zero', async () => {
    let l = await ledger();
    expect(l.platformPaise).toBe(19_900);
    expect(l.grossCollectedPaise).toBe(19_900);
    expect(l.totalPaise).toBe(0);

    await students(1);
    l = await ledger();
    expect(l.grossCollectedPaise).toBe(19_900 + 14_900);
    expect(l.platformPaise).toBe(19_900 + 7_450);
    expect(l.owedToTrainersPaise).toBe(7_450);
    expect(l.totalPaise).toBe(0);
    expect(l.unbalancedTransactions).toEqual([]);

    const e = await earnings();
    expect(e.balances.accruedPaise).toBe(7_450);
    expect(e.balances.payablePaise).toBe(0);
    expect(e.exams[0]).toMatchObject({ joins: 1, grossPaise: 14_900, sharePaise: 7_450 });
    expect(e.exams[0].state).toBe('ACCRUED');
  });

  it('is only for admins', async () => {
    await get(trainer, '/admin/finance/ledger').expect(403);
    await ctx.http().get('/admin/finance/ledger').expect(401);
  });

  it('turns accrued into payable when the exam results are published', async () => {
    await students(2);
    await publishResults();
    const e = await earnings();
    expect(e.balances.accruedPaise).toBe(0);
    expect(e.balances.payablePaise).toBe(14_900);
    expect(e.exams[0].state).toBe('PAYABLE');
  });

  it('never accepts an unbalanced entry', async () => {
    const { LedgerService } = await import('../ledger/ledger.service');
    const svc = ctx.app.get(LedgerService);
    await expect(
      svc.post(
        ctx.prisma,
        [
          { account: 'EXTERNAL', amountPaise: -100 },
          { account: 'PLATFORM', amountPaise: 99 },
        ],
        { type: 'CREDIT' },
      ),
    ).rejects.toThrow(/out of balance/);
  });
});

describe('payout details', () => {
  it('validates, encrypts the account number and only ever shows the last four digits', async () => {
    await get(trainer, '/earnings').expect(200);
    await ctx
      .http()
      .put('/earnings/payout-details')
      .set(auth(trainer))
      .send({ method: 'UPI', upiId: 'nope' })
      .expect(400);
    await ctx
      .http()
      .put('/earnings/payout-details')
      .set(auth(trainer))
      .send({ ...BANK, accountNumber: '12ab' })
      .expect(400);
    await ctx
      .http()
      .put('/earnings/payout-details')
      .set(auth(trainer))
      .send({ ...BANK, ifsc: 'BAD' })
      .expect(400);
    await ctx.http().put('/earnings/payout-details').set(auth(trainer)).send(BANK).expect(200);

    const stored = await ctx.prisma.examinerProfile.findUniqueOrThrow({
      where: { userId: trainerId },
    });
    expect(stored.bankAccountNoEnc).toBeTruthy();
    expect(stored.bankAccountNoEnc).not.toContain('123456789012');
    expect(stored.bankAccountLast4).toBe('9012');
    expect(stored.ifsc).toBe('HDFC0001234');

    const d = (await earnings()).details;
    expect(d.accountMasked).toBe('****9012');
    expect(JSON.stringify(d)).not.toContain('123456789012');

    // switching to UPI clears the bank details
    await ctx.http().put('/earnings/payout-details').set(auth(trainer)).send(UPI).expect(200);
    const after = await ctx.prisma.examinerProfile.findUniqueOrThrow({
      where: { userId: trainerId },
    });
    expect(after.bankAccountNoEnc).toBeNull();
    expect(after.upiId).toBe('trainer@okbank');
  });

  it('is for trainers only', async () => {
    const s = await newStudent(ctx, 'sam@example.com');
    await get(s, '/earnings').expect(403);
    await ctx.http().put('/earnings/payout-details').set(auth(s)).send(UPI).expect(403);
  });
});

describe('payouts', () => {
  async function readyToPay(count = 7) {
    await students(count);
    await publishResults();
    await ctx.http().put('/earnings/payout-details').set(auth(trainer)).send(BANK).expect(200);
  }

  it('needs payout details and the minimum before a request', async () => {
    await students(1);
    await publishResults();
    await post(trainer, '/payouts/request').expect(409); // no details
    await ctx.http().put('/earnings/payout-details').set(auth(trainer)).send(UPI).expect(200);
    const res = await post(trainer, '/payouts/request').expect(409); // 74.50 is below 500
    expect(res.body.message).toContain('500');
  });

  it('requests, pays with a UTR, books the ledger and sends the trainer a statement', async () => {
    await readyToPay(7); // 7 x 74.50 = 521.50
    const req = (await post(trainer, '/payouts/request').expect(200)).body;
    expect(req.amountPaise).toBe(52_150);
    expect(req.status).toBe('REQUESTED');
    expect(req.destination).toContain('****9012');
    expect(req.destination).not.toContain('123456789012');
    await post(trainer, '/payouts/request').expect(409); // one at a time

    let e = await earnings();
    expect(e.balances.pendingPaise).toBe(52_150);
    expect(e.balances.payablePaise).toBe(0);

    // the admin sees the full details to pay with
    const rows = (await get(admin, '/admin/finance/payable').expect(200)).body;
    expect(rows).toHaveLength(1);
    expect(rows[0].request.id).toBe(req.id);
    expect(rows[0].destination).toContain('123456789012');
    expect(rows[0].detailsVerified).toBe(false);
    await post(admin, `/admin/finance/examiners/${trainerId}/verify-details`).expect(200);

    await post(trainer, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR123456' }).expect(403);
    await post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: '12' }).expect(400);
    ctx.mail.clear();
    const paid = (
      await post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR123456' }).expect(200)
    ).body;
    expect(paid.status).toBe('PAID');
    expect(paid.utr).toBe('UTR123456');
    await post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR123456' }).expect(409);

    e = await earnings();
    expect(e.balances.paidPaise).toBe(52_150);
    expect(e.balances.payablePaise).toBe(0);
    expect(e.balances.pendingPaise).toBe(0);
    const l = await ledger();
    expect(l.paidOutPaise).toBe(52_150);
    expect(l.owedToTrainersPaise).toBe(0);
    expect(l.totalPaise).toBe(0);

    const mail = ctx.mail.lastTo('trainer@example.com');
    expect(mail?.subject).toContain('521.50');
    expect(mail?.text).toContain('UTR123456');

    const csv = (await get(trainer, `/payouts/${req.id}/statement.csv`).expect(200)).text;
    expect(csv).toContain('UTR123456');
    expect(csv).toContain('521.50');
    expect(csv).toContain('Student fee share');
    expect(csv).not.toContain('123456789012');
    const other = await signUp(ctx, { role: 'EXAMINER', email: 'other@example.com' });
    await get(other, `/payouts/${req.id}/statement.csv`).expect(404);
    await get(admin, `/payouts/${req.id}/statement.csv`).expect(200);
  });

  it('can be rejected, after which the trainer can ask again', async () => {
    await readyToPay();
    const req = (await post(trainer, '/payouts/request').expect(200)).body;
    await post(admin, `/admin/finance/payouts/${req.id}/reject`, { note: 'x' }).expect(400);
    await post(admin, `/admin/finance/payouts/${req.id}/reject`, {
      note: 'Details look wrong',
    }).expect(200);
    await post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR123456' }).expect(409);
    expect((await earnings()).balances.payablePaise).toBe(52_150);
    await post(trainer, '/payouts/request').expect(200);
    const history = (await get(admin, '/admin/finance/payouts?status=REJECTED').expect(200)).body;
    expect(history).toHaveLength(1);
    expect(history[0].examinerEmail).toBe('trainer@example.com');
  });

  it('lets an admin pay without a request, but never more than is payable', async () => {
    await readyToPay();
    await post(admin, '/admin/finance/payouts', {
      examinerId: trainerId,
      amountPaise: 60_000,
      utr: 'UTR777777',
    }).expect(409);
    await post(admin, '/admin/finance/payouts', {
      examinerId: trainerId,
      amountPaise: 2_000,
      utr: 'UTR777777',
    }).expect(200);
    expect((await earnings()).balances.payablePaise).toBe(50_150);

    const req = (await post(trainer, '/payouts/request').expect(200)).body;
    await post(admin, '/admin/finance/payouts', {
      examinerId: trainerId,
      amountPaise: 1_000,
      utr: 'UTR888888',
    }).expect(409); // an open request must be settled first
    await post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR999999' }).expect(200);
    expect((await ledger()).totalPaise).toBe(0);
    expect((await earnings()).balances.paidPaise).toBe(52_150);
  });

  it('cannot pay money that is not payable yet', async () => {
    await students(7);
    await ctx.http().put('/earnings/payout-details').set(auth(trainer)).send(UPI).expect(200);
    await post(admin, '/admin/finance/payouts', {
      examinerId: trainerId,
      amountPaise: 10_000,
      utr: 'UTR555555',
    }).expect(409); // exam results are not published
  });

  it('two admins paying the same request pay it once', async () => {
    await readyToPay();
    const req = (await post(trainer, '/payouts/request').expect(200)).body;
    const results = await Promise.all([
      post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR111111' }),
      post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR222222' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await ledger()).paidOutPaise).toBe(52_150);
  });
});

describe('refunds', () => {
  async function joinPayment(email: string) {
    const s = await newStudent(ctx, email);
    await joinExam(ctx, s, exam.code);
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    const payment = await ctx.prisma.payment.findFirstOrThrow({
      where: { userId: u.id, purpose: 'EXAM_JOIN' },
    });
    return { student: s, payment };
  }
  const refund = (id: string, reason = 'Student asked') =>
    post(admin, `/admin/finance/payments/${id}/refund`, { reason });

  it('returns the money, cancels the seat and takes back the trainer share', async () => {
    const a = await joinPayment('a@example.com');
    await joinPayment('b@example.com');
    expect((await earnings()).balances.accruedPaise).toBe(14_900);

    ctx.mail.clear();
    await post(trainer, `/admin/finance/payments/${a.payment.id}/refund`, { reason: 'x' }).expect(
      403,
    );
    await refund(a.payment.id, 'x').expect(400);
    await refund(a.payment.id).expect(200);
    await refund(a.payment.id).expect(409); // only once

    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: a.payment.id } });
    expect(p.status).toBe('REFUNDED');
    expect(p.refundId).toMatch(/^fake_refund_/);
    expect(await ctx.prisma.enrollment.count({ where: { paymentId: a.payment.id } })).toBe(0);
    expect(ctx.mail.lastTo('a@example.com')?.subject).toContain('149.00');

    const e = await earnings();
    expect(e.balances.accruedPaise).toBe(7_450);
    expect(e.exams[0].joins).toBe(1);
    const l = await ledger();
    expect(l.totalPaise).toBe(0);
    expect(l.unbalancedTransactions).toEqual([]);
    expect(l.owedToTrainersPaise).toBe(7_450);

    // the seat is free again: the student can join once more
    const again = await newStudent(ctx, 'a2@example.com');
    await joinExam(ctx, again, exam.code);
  });

  it('refuses when the student already started the exam, or for creation fees', async () => {
    const a = await joinPayment('a@example.com');
    const enrollment = await ctx.prisma.enrollment.findFirstOrThrow({
      where: { paymentId: a.payment.id },
    });
    await ctx
      .http()
      .post('/attempts')
      .set(auth(a.student))
      .send({ enrollmentId: enrollment.id })
      .expect(200);
    await refund(a.payment.id).expect(409);

    const creation = await ctx.prisma.payment.findFirstOrThrow({
      where: { purpose: 'EXAM_CREATION' },
    });
    await refund(creation.id).expect(409);
    await refund('00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('after payout, a refund shows as owed back', async () => {
    const first = await joinPayment('s0@example.com');
    for (let i = 1; i < 7; i++) await joinPayment(`s${i}@example.com`);
    await publishResults();
    await ctx.http().put('/earnings/payout-details').set(auth(trainer)).send(UPI).expect(200);
    const req = (await post(trainer, '/payouts/request').expect(200)).body;
    await post(admin, `/admin/finance/payouts/${req.id}/pay`, { utr: 'UTR123456' }).expect(200);

    await refund(first.payment.id).expect(200);
    let b = (await earnings()).balances;
    expect(b.owedBackPaise).toBe(7_450);
    expect(b.payablePaise).toBe(0);
    expect((await ledger()).totalPaise).toBe(0);
  });

  it('refunding an unseated payment (exam full) only touches the platform', async () => {
    await ctx.prisma.exam.update({ where: { id: exam.examId }, data: { maxStudents: 1 } });
    const s1 = await newStudent(ctx, 'one@example.com');
    const s2 = await newStudent(ctx, 'two@example.com');
    const order = (await post(s1, `/join/${exam.code}/order`).expect(200)).body;
    const order2 = (await post(s2, `/join/${exam.code}/order`).expect(200)).body;
    for (const [s, o] of [
      [s1, order],
      [s2, order2],
    ] as const) {
      const paid = (await post(s, '/payments/fake/complete', { orderId: o.orderId }).expect(200))
        .body;
      await ctx.http().post('/payments/verify').set(auth(s)).send(paid);
    }
    const orphan = await ctx.prisma.payment.findFirstOrThrow({
      where: { user: { email: 'two@example.com' }, status: 'CAPTURED' },
    });
    expect(await ctx.prisma.enrollment.count({ where: { paymentId: orphan.id } })).toBe(0);
    const before = await ledger();
    await refund(orphan.id).expect(200);
    const after = await ledger();
    expect(after.totalPaise).toBe(0);
    expect(after.owedToTrainersPaise).toBe(before.owedToTrainersPaise);
    expect(after.platformPaise).toBe(before.platformPaise - 14_900);
  });

  it('lists payments for the admin and can filter them', async () => {
    await joinPayment('a@example.com');
    const all = (await get(admin, '/admin/finance/payments').expect(200)).body;
    expect(all.length).toBeGreaterThanOrEqual(2);
    const joins = (await get(admin, '/admin/finance/payments?purpose=EXAM_JOIN&q=sam').expect(200))
      .body;
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      purpose: 'EXAM_JOIN',
      status: 'CAPTURED',
      amountPaise: 14_900,
    });
    await get(trainer, '/admin/finance/payments').expect(403);
  });
});

describe('sponsored seats', () => {
  async function buy(seats: number, who = trainer, examId = exam.examId) {
    const order = (await post(who, `/exams/${examId}/seats/order`, { seats }).expect(200)).body;
    const paid = (
      await post(who, '/payments/fake/complete', { orderId: order.orderId }).expect(200)
    ).body;
    await ctx.http().post('/payments/verify').set(auth(who)).send(paid).expect(200);
    return order;
  }
  const seats = async () => (await get(trainer, `/exams/${exam.examId}/seats`).expect(200)).body;

  it('charges seats x 149 and keeps the whole fee for NandiVex (no trainer share)', async () => {
    const order = await buy(3);
    expect(order.amountPaise).toBe(44_700);
    const s = await seats();
    expect(s.bought).toBe(3);
    expect(s.seats.every((x: { status: string }) => x.status === 'AVAILABLE')).toBe(true);
    const l = await ledger();
    expect(l.platformPaise).toBe(19_900 + 44_700);
    expect(l.owedToTrainersPaise).toBe(0);
    expect(l.totalPaise).toBe(0);
    expect((await earnings()).balances.accruedPaise).toBe(0);
    expect(ctx.mail.lastTo('trainer@example.com')?.subject).toContain('3 seats');
  });

  it('validates the order', async () => {
    await post(trainer, `/exams/${exam.examId}/seats/order`, { seats: 0 }).expect(400);
    await post(trainer, `/exams/${exam.examId}/seats/order`, { seats: 500 }).expect(400);
    const other = await signUp(ctx, { role: 'EXAMINER', email: 'other@example.com' });
    await post(other, `/exams/${exam.examId}/seats/order`, { seats: 1 }).expect(404);
    const sam = await newStudent(ctx, 'sam@example.com');
    await post(sam, `/exams/${exam.examId}/seats/order`, { seats: 1 }).expect(403);
    const draft = (
      await post(trainer, '/exams', { title: 'Draft exam', durationMinutes: 30 }).expect(201)
    ).body;
    await post(trainer, `/exams/${draft.id}/seats/order`, { seats: 1 }).expect(409);
  });

  it('counts unused seats against the exam capacity, for sponsors and for paying students', async () => {
    await ctx.prisma.exam.update({ where: { id: exam.examId }, data: { maxStudents: 3 } });
    await buy(2);
    await post(trainer, `/exams/${exam.examId}/seats/order`, { seats: 2 }).expect(409);
    const a = await newStudent(ctx, 'a@example.com');
    await joinExam(ctx, a, exam.code); // the last free place
    const b = await newStudent(ctx, 'b@example.com');
    const info = (await get(b, `/join/${exam.code}`).expect(200)).body;
    expect(info.state).toBe('FULL');
    await post(b, `/join/${exam.code}/order`).expect(409);
  });

  it('assigns seats by email, emails the link, and only that student can use it', async () => {
    await buy(3);
    ctx.mail.clear();
    await post(trainer, `/exams/${exam.examId}/seats/assign`, { emails: ['not-an-email'] }).expect(
      400,
    );
    const assigned = (
      await post(trainer, `/exams/${exam.examId}/seats/assign`, {
        emails: ['Lee@Example.com', 'kim@example.com'],
      }).expect(200)
    ).body;
    expect(assigned.seats.filter((s: { status: string }) => s.status === 'ASSIGNED')).toHaveLength(
      2,
    );
    const invite = ctx.mail.lastTo('lee@example.com');
    expect(invite?.text).toMatch(/\/redeem\/\?token=/);
    await post(trainer, `/exams/${exam.examId}/seats/assign`, {
      emails: ['lee@example.com'],
    }).expect(409);
    await post(trainer, `/exams/${exam.examId}/seats/assign`, {
      emails: ['x1@example.com', 'x2@example.com'],
    }).expect(409); // only one seat left

    const token = invite!.text.match(/token=([\w-]+)/)![1];
    const lee = await newStudent(ctx, 'lee@example.com');
    const wrong = await newStudent(ctx, 'wrong@example.com');
    const preview = (await get(lee, `/seats/preview?token=${token}`).expect(200)).body;
    expect(preview).toMatchObject({ examTitle: 'Cloud Fundamentals', forEmail: 'lee@example.com' });
    await post(wrong, '/seats/redeem', { token }).expect(409);

    const joined = (await post(lee, '/seats/redeem', { token }).expect(200)).body;
    expect(joined.examId).toBe(exam.examId);
    const mine = (await get(lee, '/me/enrollments').expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0].canStart).toBe(true);
    // no money moved and no payment exists for it
    const enrollment = await ctx.prisma.enrollment.findUniqueOrThrow({
      where: { id: joined.enrollmentId },
    });
    expect(enrollment.paymentId).toBeNull();
    expect(enrollment.seatId).toBeTruthy();
    expect((await ledger()).platformPaise).toBe(19_900 + 44_700);

    await post(lee, '/seats/redeem', { token }).expect(404); // used
    await get(lee, `/seats/preview?token=${token}`).expect(404);
    const s = await seats();
    expect(s.redeemed).toBe(1);
    expect(
      s.seats.find((x: { email: string }) => x.email === 'lee@example.com').redeemedByName,
    ).toBe('Sam Student');
  });

  it('lets anyone with the link use an unassigned seat, once', async () => {
    await buy(1);
    const token = (await seats()).seats[0].token;
    const a = await newStudent(ctx, 'a@example.com');
    const b = await newStudent(ctx, 'b@example.com');
    const results = await Promise.all([
      post(a, '/seats/redeem', { token }),
      post(b, '/seats/redeem', { token }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ctx.prisma.enrollment.count({ where: { examId: exam.examId } })).toBe(1);
    await get(a, '/seats/preview?token=nope-nope-nope-nope').expect(404);
    await ctx.http().post('/seats/redeem').set(auth(trainer)).send({ token }).expect(403);
  });

  it('does not let a student who already paid use a seat, and keeps the seat free', async () => {
    await buy(1);
    const token = (await seats()).seats[0].token;
    const a = await newStudent(ctx, 'a@example.com');
    await joinExam(ctx, a, exam.code);
    await post(a, '/seats/redeem', { token }).expect(409);
    expect((await seats()).redeemed).toBe(0);
  });

  it('refunds an unused order, but not one that is in use', async () => {
    await buy(2);
    const pack = await ctx.prisma.payment.findFirstOrThrow({ where: { purpose: 'SEAT_PACK' } });
    const token = (await seats()).seats[0].token;
    const a = await newStudent(ctx, 'a@example.com');
    await post(a, '/seats/redeem', { token }).expect(200);
    await post(admin, `/admin/finance/payments/${pack.id}/refund`, { reason: 'Mistake' }).expect(
      409,
    );

    const a2 = await ctx.prisma.seat.findUniqueOrThrow({ where: { token } });
    await ctx.prisma.enrollment.delete({ where: { id: a2.enrollmentId! } });
    await ctx.prisma.seat.update({
      where: { token },
      data: { redeemedAt: null, redeemedById: null, enrollmentId: null },
    });
    await post(admin, `/admin/finance/payments/${pack.id}/refund`, { reason: 'Mistake' }).expect(
      200,
    );
    expect((await seats()).bought).toBe(0);
    const l = await ledger();
    expect(l.platformPaise).toBe(19_900);
    expect(l.totalPaise).toBe(0);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createTestApp, signUp } from '../../test/helpers';
import { PublishedExam, auth, joinExam, newStudent, publishExam } from '../../test/scenario';

let ctx: TestContext;
let trainer: { accessToken: string };
let sam: { accessToken: string };
let exam: PublishedExam;
let enrollmentId: string;

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
  exam = await publishExam(ctx, trainer);
  enrollmentId = await joinExam(ctx, sam, exam.code);
});

const start = (who = sam, id = enrollmentId) =>
  ctx.http().post('/attempts').set(auth(who)).send({ enrollmentId: id });

async function begin() {
  return (await start().expect(200)).body as {
    id: string;
    questions: {
      id: string;
      number: number;
      type: string;
      options: { id: number; text: string }[];
    }[];
    deadlineAt: string;
    answers: Record<string, unknown>;
  };
}

describe('starting', () => {
  it('only for the enrolled student', async () => {
    const other = await newStudent(ctx, 'other@example.com');
    await start(other).expect(404);
    await ctx.http().post('/attempts').expect(401);
    await ctx.http().post('/attempts').set(auth(trainer)).send({ enrollmentId }).expect(403);
  });

  it('refuses before the exam opens and after it closes', async () => {
    await ctx.prisma.exam.update({
      where: { id: exam.examId },
      data: { startsAt: new Date(Date.now() + 3_600_000) },
    });
    await start().expect(409);
    await ctx.prisma.exam.update({
      where: { id: exam.examId },
      data: { startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 1000) },
    });
    await start().expect(409);
  });

  it('never sends answers, explanations or rubrics', async () => {
    const a = await begin();
    const raw = JSON.stringify(a);
    expect(raw).not.toContain('correctOptions');
    expect(raw).not.toContain('SECRET EXPLANATION');
    expect(raw).not.toContain('SECRET RUBRIC');
    expect(a.questions).toHaveLength(3);
    expect(a.questions.map((q) => q.number)).toEqual([1, 2, 3]);
  });

  it('fixes the deadline on the server and returns the same attempt on a second start', async () => {
    const a = await begin();
    const minutes = (new Date(a.deadlineAt).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThanOrEqual(60);
    const b = await begin();
    expect(b.id).toBe(a.id);
    expect(b.deadlineAt).toBe(a.deadlineAt);
    expect(await ctx.prisma.attempt.count()).toBe(1);
  });

  it('caps the deadline at the closing time', async () => {
    await ctx.prisma.exam.update({
      where: { id: exam.examId },
      data: { endsAt: new Date(Date.now() + 10 * 60_000) },
    });
    const a = await begin();
    const minutes = (new Date(a.deadlineAt).getTime() - Date.now()) / 60000;
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it("keeps the trainer's order when shuffling is off, and shuffles when it is on", async () => {
    await ctx.reset();
    trainer = await signUp(ctx, { role: 'EXAMINER', email: 'trainer@example.com' });
    sam = await newStudent(ctx, 'sam@example.com');
    const fixed = await publishExam(ctx, trainer, {
      shuffleQuestions: false,
      shuffleOptions: false,
    });
    const id = await joinExam(ctx, sam, fixed.code);
    const a = (await start(sam, id).expect(200)).body;
    expect(a.questions.map((q: { id: string }) => q.id)).toEqual([
      fixed.questionIds.single,
      fixed.questionIds.multi,
      fixed.questionIds.subjective,
    ]);
    expect(a.questions[0].options.map((o: { id: number }) => o.id)).toEqual([0, 1, 2, 3]);

    // With shuffling on, every student still gets each option exactly once.
    const mixed = await publishExam(ctx, trainer);
    for (let i = 0; i < 4; i++) {
      const s = await newStudent(ctx, `s${i}@example.com`);
      const e = await joinExam(ctx, s, mixed.code);
      const r = (await start(s, e).expect(200)).body;
      const single = r.questions.find((q: { id: string }) => q.id === mixed.questionIds.single);
      expect(single.options.map((o: { id: number }) => o.id).sort()).toEqual([0, 1, 2, 3]);
    }
  });
});

describe('answering', () => {
  const put = (attemptId: string, qid: string, body: object, who = sam) =>
    ctx.http().put(`/attempts/${attemptId}/answers/${qid}`).set(auth(who)).send(body);

  it('autosaves choices, text and flags, and returns them on reload', async () => {
    const a = await begin();
    await put(a.id, exam.questionIds.single, { selected: [2] }).expect(200);
    await put(a.id, exam.questionIds.multi, { selected: [1, 0, 1] }).expect(200);
    await put(a.id, exam.questionIds.subjective, {
      text: 'You secure the cloud, they secure the hardware.',
    }).expect(200);
    await put(a.id, exam.questionIds.single, { flagged: true }).expect(200); // flag only: keeps the choice

    const reloaded = (await ctx.http().get(`/attempts/${a.id}`).set(auth(sam)).expect(200)).body;
    expect(reloaded.answers[exam.questionIds.single]).toEqual({
      selected: [2],
      text: '',
      flagged: true,
    });
    expect(reloaded.answers[exam.questionIds.multi].selected).toEqual([0, 1]);
    expect(reloaded.answers[exam.questionIds.subjective].text).toContain(
      'shared'.slice(0, 0) + 'secure the cloud',
    );
  });

  it('rejects impossible answers', async () => {
    const a = await begin();
    await put(a.id, exam.questionIds.single, { selected: [0, 1] }).expect(409);
    await put(a.id, exam.questionIds.single, { selected: [9] }).expect(400);
    await put(a.id, exam.questionIds.multi, { selected: [3] }).expect(409);
    await put(a.id, exam.questionIds.single, {}).expect(400);
    await put(a.id, '00000000-0000-4000-8000-000000000000', { selected: [0] }).expect(404);
  });

  it("keeps one student's attempt private from another", async () => {
    const a = await begin();
    const other = await newStudent(ctx, 'other@example.com');
    await ctx.http().get(`/attempts/${a.id}`).set(auth(other)).expect(404);
    await put(a.id, exam.questionIds.single, { selected: [0] }, other).expect(404);
    await ctx.http().post(`/attempts/${a.id}/submit`).set(auth(other)).expect(404);
  });
});

describe('finishing', () => {
  it('submits once, then locks everything and hides the questions', async () => {
    const a = await begin();
    const done = await ctx.http().post(`/attempts/${a.id}/submit`).set(auth(sam)).expect(200);
    expect(done.body).toMatchObject({
      status: 'GRADED',
      endReason: 'SUBMITTED_BY_STUDENT',
      questions: [],
    });
    await ctx
      .http()
      .put(`/attempts/${a.id}/answers/${exam.questionIds.single}`)
      .set(auth(sam))
      .send({ selected: [0] })
      .expect(409);
    // Submitting again is harmless.
    await ctx.http().post(`/attempts/${a.id}/submit`).set(auth(sam)).expect(200);
    // And the student cannot start a fresh attempt.
    const again = (await start().expect(200)).body;
    expect(again.id).toBe(a.id);
    expect(again.status).toBe('GRADED');
    const list = (await ctx.http().get('/me/enrollments').set(auth(sam)).expect(200)).body;
    expect(list[0].canStart).toBe(false);
  });

  it('accepts a save just after the deadline (grace) but not long after', async () => {
    const a = await begin();
    await ctx.prisma.attempt.update({
      where: { id: a.id },
      data: { deadlineAt: new Date(Date.now() - 1000) },
    });
    await ctx
      .http()
      .put(`/attempts/${a.id}/answers/${exam.questionIds.single}`)
      .set(auth(sam))
      .send({ selected: [1] })
      .expect(200);

    await ctx.prisma.attempt.update({
      where: { id: a.id },
      data: { deadlineAt: new Date(Date.now() - 60_000) },
    });
    await ctx
      .http()
      .put(`/attempts/${a.id}/answers/${exam.questionIds.single}`)
      .set(auth(sam))
      .send({ selected: [2] })
      .expect(409);
    const row = await ctx.prisma.attempt.findUnique({ where: { id: a.id } });
    expect(row).toMatchObject({ status: 'GRADED', endReason: 'TIME_UP' });
    const saved = await ctx.prisma.answer.findFirst({ where: { attemptId: a.id } });
    expect(saved?.selected).toEqual([1]); // the late write did not land
  });

  it('auto-submits an overdue attempt when it is next opened', async () => {
    const a = await begin();
    await ctx.prisma.attempt.update({
      where: { id: a.id },
      data: { deadlineAt: new Date(Date.now() - 60_000) },
    });
    const view = (await ctx.http().get(`/attempts/${a.id}`).set(auth(sam)).expect(200)).body;
    expect(view).toMatchObject({ status: 'GRADED', endReason: 'TIME_UP', questions: [] });
  });
});

describe('proctoring', () => {
  const event = (attemptId: string, type: string) =>
    ctx.http().post(`/attempts/${attemptId}/events`).set(auth(sam)).send({ type });
  const ageEvents = () =>
    ctx.prisma.proctorEvent.updateMany({ data: { createdAt: new Date(Date.now() - 10_000) } });

  it('counts a strike, merges events that fire together, and only logs copy/paste', async () => {
    const a = await begin();
    expect((await event(a.id, 'TAB_HIDDEN').expect(200)).body).toMatchObject({
      strikes: 1,
      ended: false,
    });
    expect((await event(a.id, 'WINDOW_BLUR').expect(200)).body.strikes).toBe(1); // same moment
    await ageEvents();
    expect((await event(a.id, 'COPY').expect(200)).body.strikes).toBe(1);
    expect((await event(a.id, 'CONTEXT_MENU').expect(200)).body.strikes).toBe(1);
    expect((await event(a.id, 'FULLSCREEN_EXIT').expect(200)).body.strikes).toBe(2);
    expect(await ctx.prisma.proctorEvent.count({ where: { attemptId: a.id } })).toBe(5);
  });

  it('auto-submits on the third strike and then refuses writes', async () => {
    const a = await begin();
    for (let i = 1; i <= 2; i++) {
      await event(a.id, 'TAB_HIDDEN').expect(200);
      await ageEvents();
    }
    const last = (await event(a.id, 'FULLSCREEN_EXIT').expect(200)).body;
    expect(last).toMatchObject({ strikes: 3, ended: true, status: 'AUTO_SUBMITTED' });
    const row = await ctx.prisma.attempt.findUnique({ where: { id: a.id } });
    expect(row).toMatchObject({ status: 'GRADED', endReason: 'STRIKES' });
    await ctx
      .http()
      .put(`/attempts/${a.id}/answers/${exam.questionIds.single}`)
      .set(auth(sam))
      .send({ selected: [0] })
      .expect(409);
    // Events after the end change nothing.
    expect((await event(a.id, 'TAB_HIDDEN').expect(200)).body.ended).toBe(true);
  });

  it('rejects unknown event types', async () => {
    const a = await begin();
    await event(a.id, 'SOMETHING_ELSE').expect(400);
  });
});

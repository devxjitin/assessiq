import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createTestApp, signUp } from '../../test/helpers';
import { PublishedExam, auth, joinExam, newStudent, publishExam } from '../../test/scenario';
import { CodeJudgeService } from './code-judge.service';
import { CODE_RUNNER, FakeRunner } from './code-runner';

let ctx: TestContext;
let runner: FakeRunner;
let judge: CodeJudgeService;
let trainer: { accessToken: string };
let sam: { accessToken: string };
let exam: PublishedExam;
let attemptId: string;
let codeQ: string;

/**
 * The fake runner echoes its input. Expected outputs below are chosen so an echo program passes
 * the first two tests and fails the third (weights 1, 3 and 2 of 6).
 */
const CODING = {
  type: 'CODING',
  body: 'Print the input back.',
  marks: 12,
  coding: {
    languages: ['python', 'cpp'],
    starterCode: { python: '# write code' },
    timeLimitMs: 2000,
    memoryMb: 256,
    testCases: [
      { input: 'a', expectedOutput: 'a', hidden: false, weight: 1 },
      { input: 'b', expectedOutput: 'b', hidden: true, weight: 3 },
      { input: 'c', expectedOutput: 'HIDDEN-SECRET-ANSWER', hidden: true, weight: 2 },
    ],
  },
};

beforeAll(async () => {
  ctx = await createTestApp();
  runner = ctx.app.get<FakeRunner>(CODE_RUNNER);
  judge = ctx.app.get(CodeJudgeService);
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await ctx.reset();
  runner.calls = [];
  trainer = await signUp(ctx, { role: 'EXAMINER', email: 'trainer@example.com' });
  sam = await newStudent(ctx, 'sam@example.com');
  exam = await publishExam(ctx, trainer, {}, [CODING]);
  codeQ = exam.extraIds[0];
  const enrollmentId = await joinExam(ctx, sam, exam.code);
  attemptId = (await ctx.http().post('/attempts').set(auth(sam)).send({ enrollmentId }).expect(200))
    .body.id;
});

const save = (body: object) =>
  ctx.http().put(`/attempts/${attemptId}/answers/${codeQ}`).set(auth(sam)).send(body);
const run = (source: string, language = 'python') =>
  ctx
    .http()
    .post(`/attempts/${attemptId}/questions/${codeQ}/run`)
    .set(auth(sam))
    .send({ language, source });
const submit = () => ctx.http().post(`/attempts/${attemptId}/submit`).set(auth(sam)).expect(200);
const results = () => ctx.http().get(`/exams/${exam.examId}/results`).set(auth(trainer));
const rowFor = async () => (await results().expect(200)).body.rows[0];

describe('authoring coding questions', () => {
  const draft = async () => {
    const e = await ctx
      .http()
      .post('/exams')
      .set(auth(trainer))
      .send({ title: 'Draft', durationMinutes: 30 })
      .expect(201);
    return e.body.id as string;
  };
  const add = async (id: string, coding: object) =>
    ctx
      .http()
      .post(`/exams/${id}/questions`)
      .set(auth(trainer))
      .send({ ...CODING, coding });

  it('stores the spec with an id on every test case', async () => {
    const id = await draft();
    const res = await add(id, CODING.coding).then((r) => r);
    expect(res.status).toBe(201);
    expect(res.body.coding.testCases).toHaveLength(3);
    expect(res.body.coding.testCases.every((t: { id: string }) => t.id)).toBe(true);
    expect(res.body.coding.languages).toEqual(['python', 'cpp']);
  });

  it('needs at least one visible sample case', async () => {
    const id = await draft();
    const allHidden = CODING.coding.testCases.map((t) => ({ ...t, hidden: true }));
    await add(id, { ...CODING.coding, testCases: allHidden }).then((r) =>
      expect(r.status).toBe(400),
    );
  });

  it('rejects unknown languages, empty test lists and oversize limits', async () => {
    const id = await draft();
    for (const bad of [
      { ...CODING.coding, languages: ['cobol'] },
      { ...CODING.coding, languages: [] },
      { ...CODING.coding, testCases: [] },
      { ...CODING.coding, timeLimitMs: 60_000 },
      { ...CODING.coding, memoryMb: 4096 },
    ]) {
      expect((await add(id, bad)).status).toBe(400);
    }
  });

  it("the trainer's preview as a student never contains hidden cases", async () => {
    const res = await ctx
      .http()
      .get(`/exams/${exam.examId}/preview`)
      .set(auth(trainer))
      .expect(200);
    const q = res.body.questions.find((x: { type: string }) => x.type === 'CODING');
    expect(q.coding.samples).toEqual([{ input: 'a', expectedOutput: 'a' }]);
    expect(q.coding.hiddenCount).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain('HIDDEN-SECRET-ANSWER');
  });
});

describe('taking a coding question', () => {
  it('shows samples and starter code, and never the hidden cases', async () => {
    const res = await ctx.http().get(`/attempts/${attemptId}`).set(auth(sam)).expect(200);
    const q = res.body.questions.find((x: { type: string }) => x.type === 'CODING');
    expect(q.coding).toMatchObject({
      languages: ['python', 'cpp'],
      starterCode: { python: '# write code' },
      samples: [{ input: 'a', expectedOutput: 'a' }],
      hiddenCount: 2,
    });
    expect(JSON.stringify(res.body)).not.toContain('HIDDEN-SECRET-ANSWER');
  });

  it('autosaves the code and language, and refuses a language that is not allowed', async () => {
    await save({ text: 'print(1)', language: 'python' }).expect(200);
    const view = (await ctx.http().get(`/attempts/${attemptId}`).set(auth(sam)).expect(200)).body;
    expect(view.answers[codeQ]).toMatchObject({ text: 'print(1)', language: 'python' });
    await save({ text: 'x', language: 'java' }).expect(409);
  });

  it('runs on the sample cases only and reports each one', async () => {
    const ok = (await run('print(input())').expect(200)).body;
    expect(ok.results).toHaveLength(1);
    expect(ok.results[0]).toMatchObject({ input: 'a', status: 'PASSED', actualOutput: 'a' });
    expect(ok.runsLeft).toBe(39);
    expect(runner.calls.map((c) => c.stdin)).toEqual(['a']); // hidden inputs were never run

    await ctx.prisma.answer.updateMany({ data: { lastRunAt: null } });
    const wrong = (await run('WRONG').expect(200)).body;
    expect(wrong.results[0]).toMatchObject({ status: 'WRONG_ANSWER', actualOutput: 'wrong' });
  });

  it('explains compile errors, runtime errors and timeouts', async () => {
    const compile = (await run('COMPILE_ERROR').expect(200)).body.results[0];
    expect(compile).toMatchObject({ status: 'COMPILE_ERROR', message: 'error: expected ;' });
    await ctx.prisma.answer.updateMany({ data: { lastRunAt: null } });
    expect((await run('TIME_LIMIT').expect(200)).body.results[0].status).toBe('TIME_LIMIT');
    await ctx.prisma.answer.updateMany({ data: { lastRunAt: null } });
    expect((await run('RUNTIME_ERROR').expect(200)).body.results[0].status).toBe('RUNTIME_ERROR');
  });

  it('saves the code that was run', async () => {
    await run('print("hello")').expect(200);
    const view = (await ctx.http().get(`/attempts/${attemptId}`).set(auth(sam)).expect(200)).body;
    expect(view.answers[codeQ]).toMatchObject({ text: 'print("hello")', language: 'python' });
  });

  it('limits how fast and how often a student can run', async () => {
    await run('x').expect(200);
    await run('x').expect(429); // too soon
    await ctx.prisma.answer.updateMany({ data: { lastRunAt: null, runs: 40 } });
    await run('x').expect(429); // budget used up
  });

  it('gives the run back when the sandbox is down', async () => {
    await run('UNAVAILABLE').expect(503);
    const a = await ctx.prisma.answer.findFirstOrThrow({ where: { attemptId, questionId: codeQ } });
    expect(a.runs).toBe(0);
  });

  it('only allowed languages, only your own attempt, not after submitting', async () => {
    await run('x', 'java').expect(409);
    const other = await newStudent(ctx, 'other@example.com');
    await ctx
      .http()
      .post(`/attempts/${attemptId}/questions/${codeQ}/run`)
      .set(auth(other))
      .send({ language: 'python', source: 'x' })
      .expect(404);
    await ctx
      .http()
      .post(`/attempts/${attemptId}/questions/${exam.questionIds.single}/run`)
      .set(auth(sam))
      .send({ language: 'python', source: 'x' })
      .expect(404); // not a coding question
    await submit();
    await run('x').expect(409);
  });
});

describe('automatic grading', () => {
  it('queues the code when the attempt ends and marks it by test weight', async () => {
    await save({ text: 'print(input())', language: 'python' }).expect(200);
    await submit();
    const queued = await ctx.prisma.codeSubmission.findFirstOrThrow({ where: { attemptId } });
    expect(queued.status).toBe('QUEUED');
    expect((await rowFor()).status).toBe('SUBMITTED'); // waiting for the judge

    expect(await judge.drain()).toBe(1);
    const job = await ctx.prisma.codeSubmission.findFirstOrThrow({ where: { attemptId } });
    expect(job).toMatchObject({ status: 'DONE', passedWeight: 4, totalWeight: 6 });
    const a = await ctx.prisma.answer.findFirstOrThrow({ where: { attemptId, questionId: codeQ } });
    expect(a.marksAwarded).toBe(8); // 12 x 4/6
    const row = await rowFor();
    expect(row).toMatchObject({ status: 'GRADED', score: 8 });
  });

  it('gives zero for code that does not compile', async () => {
    await save({ text: 'COMPILE_ERROR', language: 'cpp' }).expect(200);
    await submit();
    await judge.drain();
    const job = await ctx.prisma.codeSubmission.findFirstOrThrow({ where: { attemptId } });
    expect(job.passedWeight).toBe(0);
    const tests = job.results as { status: string }[];
    expect(tests.every((t) => t.status === 'COMPILE_ERROR')).toBe(true);
    expect((await rowFor()).score).toBe(0);
  });

  it('does not queue blank code and scores it zero straight away', async () => {
    await submit();
    expect(await ctx.prisma.codeSubmission.count()).toBe(0);
    expect((await rowFor()).status).toBe('GRADED');
  });

  it('retries when the sandbox is unreachable, then leaves the answer for the trainer', async () => {
    await save({ text: 'UNAVAILABLE', language: 'python' }).expect(200);
    await submit();
    for (let i = 1; i <= 5; i++) {
      await judge.drain();
      const job = await ctx.prisma.codeSubmission.findFirstOrThrow({ where: { attemptId } });
      expect(job.tries).toBe(i);
      if (i < 5) {
        expect(await judge.drain()).toBe(0); // waits before trying again
        await ctx.prisma.codeSubmission.update({ where: { id: job.id }, data: { lockedAt: null } });
      }
      expect(job.status).toBe(i < 5 ? 'QUEUED' : 'ERROR');
    }
    expect((await rowFor()).pendingGrading).toBe(1);
    // The trainer marks it by hand and the attempt completes.
    await ctx
      .http()
      .put(`/exams/${exam.examId}/attempts/${attemptId}/answers/${codeQ}/grade`)
      .set(auth(trainer))
      .send({ marks: 7 })
      .expect(200);
    expect((await rowFor()).status).toBe('GRADED');
  });

  it('never overwrites marks the trainer already gave', async () => {
    await save({ text: 'print(input())', language: 'python' }).expect(200);
    await submit();
    await ctx
      .http()
      .put(`/exams/${exam.examId}/attempts/${attemptId}/answers/${codeQ}/grade`)
      .set(auth(trainer))
      .send({ marks: 12, feedback: 'Reviewed by hand' })
      .expect(200);
    await judge.drain();
    const a = await ctx.prisma.answer.findFirstOrThrow({ where: { attemptId, questionId: codeQ } });
    expect(a.marksAwarded).toBe(12);
  });

  it('two judges never grade the same job twice', async () => {
    await save({ text: 'print(input())', language: 'python' }).expect(200);
    await submit();
    runner.calls = [];
    const [a, b] = await Promise.all([judge.processOne(), judge.processOne()]);
    expect(a || b).toBe(true);
    expect(runner.calls).toHaveLength(3); // one pass over three tests, not two
  });

  it('grades code from an attempt whose time ran out', async () => {
    await save({ text: 'print(input())', language: 'python' }).expect(200);
    await ctx.prisma.attempt.update({
      where: { id: attemptId },
      data: { deadlineAt: new Date(Date.now() - 60_000) },
    });
    await results().expect(200); // trainer opens results: the attempt is ended and queued
    await judge.drain();
    expect((await rowFor()).status).toBe('GRADED');
  });
});

describe('results for coding questions', () => {
  beforeEach(async () => {
    await save({ text: 'print(input())', language: 'python' }).expect(200);
    await submit();
    await judge.drain();
  });

  it('shows the trainer the code and per-test outcome, without hidden data', async () => {
    const d = (
      await ctx
        .http()
        .get(`/exams/${exam.examId}/attempts/${attemptId}`)
        .set(auth(trainer))
        .expect(200)
    ).body;
    const q = d.questions.find((x: { type: string }) => x.type === 'CODING');
    expect(q).toMatchObject({ text: 'print(input())', language: 'python', marksAwarded: 8 });
    expect(q.submission).toMatchObject({ status: 'DONE', passedWeight: 4, totalWeight: 6 });
    expect(q.submission.tests.map((t: { hidden: boolean }) => t.hidden)).toEqual([
      false,
      true,
      true,
    ]);
    expect(JSON.stringify(q.submission)).not.toContain('HIDDEN-SECRET-ANSWER');
  });

  it('waits for the judge before results can be published', async () => {
    // A second student whose code has not been judged yet.
    const lena = await newStudent(ctx, 'lena@example.com');
    const enrollmentId = await joinExam(ctx, lena, exam.code);
    const lenaAttempt = (
      await ctx.http().post('/attempts').set(auth(lena)).send({ enrollmentId }).expect(200)
    ).body.id;
    await ctx
      .http()
      .put(`/attempts/${lenaAttempt}/answers/${codeQ}`)
      .set(auth(lena))
      .send({ text: 'print(input())', language: 'python' })
      .expect(200);
    await ctx.http().post(`/attempts/${lenaAttempt}/submit`).set(auth(lena)).expect(200);
    await ctx.prisma.exam.update({
      where: { id: exam.examId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    // Sam's written answer is blank-free? It is not: mark Sam's subjective-free exam state.
    const res = await ctx.http().post(`/exams/${exam.examId}/finalize`).set(auth(trainer));
    expect(res.status).toBe(409);
    await judge.drain();
    await ctx.http().post(`/exams/${exam.examId}/finalize`).set(auth(trainer)).expect(200);
  });

  it('students see pass/fail per test only after publishing', async () => {
    await ctx.http().get(`/attempts/${attemptId}/result`).set(auth(sam)).expect(409);
    await ctx.prisma.exam.update({
      where: { id: exam.examId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    await ctx.http().post(`/exams/${exam.examId}/finalize`).set(auth(trainer)).expect(200);
    const r = (await ctx.http().get(`/attempts/${attemptId}/result`).set(auth(sam)).expect(200))
      .body;
    const q = r.questions.find((x: { type: string }) => x.type === 'CODING');
    expect(q).toMatchObject({ language: 'python', text: 'print(input())', marksAwarded: 8 });
    expect(q.submission.tests.filter((t: { passed: boolean }) => t.passed)).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain('HIDDEN-SECRET-ANSWER');
  });
});

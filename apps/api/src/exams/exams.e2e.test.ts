import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createTestApp, signUp } from '../../test/helpers';

let ctx: TestContext;
let trainer: { accessToken: string };
let other: { accessToken: string };
let student: { accessToken: string };

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await ctx.reset();
  trainer = await signUp(ctx, { role: 'EXAMINER', email: 'trainer@example.com' });
  other = await signUp(ctx, { role: 'EXAMINER', email: 'other@example.com' });
  student = await signUp(ctx, { role: 'STUDENT', email: 'student@example.com' });
});

const auth = (t: { accessToken: string }) => ({ Authorization: `Bearer ${t.accessToken}` });

async function newExam(token = trainer, body: object = {}) {
  const res = await ctx
    .http()
    .post('/exams')
    .set(auth(token))
    .send({ title: 'Network Security Basics', ...body })
    .expect(201);
  return res.body as { id: string };
}

const single = {
  type: 'SINGLE',
  body: 'Which port does HTTPS use?',
  options: ['80', '443', '22'],
  correctOptions: [1],
  marks: 4,
  negativeMarks: 1,
  explanation: 'TLS runs on 443',
};

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('exam access', () => {
  it('is for trainers only', async () => {
    await ctx.http().get('/exams').expect(401);
    await ctx.http().get('/exams').set(auth(student)).expect(403);
    await ctx.http().post('/exams').set(auth(student)).send({ title: 'Nope nope' }).expect(403);
  });

  it("hides one trainer's exams from another", async () => {
    const exam = await newExam();
    await ctx.http().get(`/exams/${exam.id}`).set(auth(other)).expect(404);
    await ctx
      .http()
      .patch(`/exams/${exam.id}`)
      .set(auth(other))
      .send({ title: 'Stolen' })
      .expect(404);
    await ctx.http().delete(`/exams/${exam.id}`).set(auth(other)).expect(404);
    await ctx.http().post(`/exams/${exam.id}/questions`).set(auth(other)).send(single).expect(404);
    const list = await ctx.http().get('/exams').set(auth(other)).expect(200);
    expect(list.body).toHaveLength(0);
  });

  it('treats a malformed id as not found', async () => {
    await ctx.http().get('/exams/not-a-uuid').set(auth(trainer)).expect(404);
  });
});

describe('exam settings', () => {
  it('creates a draft with defaults and lists it', async () => {
    const res = await ctx
      .http()
      .post('/exams')
      .set(auth(trainer))
      .send({ title: 'Linux Admin Test' })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      durationMinutes: 60,
      passPercent: 40,
      shuffleQuestions: true,
      questionCount: 0,
      totalMarks: 0,
    });
    const list = await ctx.http().get('/exams').set(auth(trainer)).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('validates settings', async () => {
    const bad = (body: object) =>
      ctx.http().post('/exams').set(auth(trainer)).send(body).expect(400);
    await bad({ title: 'ab' });
    await bad({ title: 'Valid title', durationMinutes: 2 });
    await bad({ title: 'Valid title', durationMinutes: 361 });
    await bad({ title: 'Valid title', passPercent: 101 });
    await bad({
      title: 'Valid title',
      startsAt: '2027-01-02T10:00:00Z',
      endsAt: '2027-01-01T10:00:00Z',
    });
  });

  it('updates settings and checks the window against stored values', async () => {
    const exam = await newExam(trainer, { startsAt: '2027-01-02T10:00:00Z' });
    const ok = await ctx
      .http()
      .patch(`/exams/${exam.id}`)
      .set(auth(trainer))
      .send({ durationMinutes: 90, endsAt: '2027-01-02T12:00:00Z' })
      .expect(200);
    expect(ok.body.durationMinutes).toBe(90);
    await ctx
      .http()
      .patch(`/exams/${exam.id}`)
      .set(auth(trainer))
      .send({ endsAt: '2027-01-01T00:00:00Z' })
      .expect(400);
    await ctx.http().patch(`/exams/${exam.id}`).set(auth(trainer)).send({}).expect(400);
  });

  it('blocks edits once the exam is not a draft', async () => {
    const exam = await newExam();
    await ctx.prisma.exam.update({ where: { id: exam.id }, data: { status: 'PUBLISHED' } });
    await ctx
      .http()
      .patch(`/exams/${exam.id}`)
      .set(auth(trainer))
      .send({ title: 'Changed' })
      .expect(409);
    await ctx
      .http()
      .post(`/exams/${exam.id}/questions`)
      .set(auth(trainer))
      .send(single)
      .expect(409);
    await ctx.http().delete(`/exams/${exam.id}`).set(auth(trainer)).expect(409);
  });

  it('deletes a draft with its questions', async () => {
    const exam = await newExam();
    await ctx
      .http()
      .post(`/exams/${exam.id}/questions`)
      .set(auth(trainer))
      .send(single)
      .expect(201);
    await ctx.http().delete(`/exams/${exam.id}`).set(auth(trainer)).expect(204);
    expect(await ctx.prisma.question.count()).toBe(0);
  });
});

describe('questions', () => {
  it('adds single, multiple and subjective questions in order, with totals', async () => {
    const exam = await newExam();
    const add = (body: object) =>
      ctx.http().post(`/exams/${exam.id}/questions`).set(auth(trainer)).send(body);
    await add(single).expect(201);
    const multi = await add({
      type: 'MULTI',
      body: 'Pick the secure protocols',
      options: ['HTTP', 'HTTPS', 'SSH', 'Telnet'],
      correctOptions: [2, 1],
      marks: 6,
    }).expect(201);
    expect(multi.body.correctOptions).toEqual([1, 2]);
    expect(multi.body.position).toBe(2);
    await add({
      type: 'SUBJECTIVE',
      body: 'Explain TLS.',
      marks: 10,
      rubric: 'Mention handshake',
    }).expect(201);

    const detail = await ctx.http().get(`/exams/${exam.id}`).set(auth(trainer)).expect(200);
    expect(detail.body.questionCount).toBe(3);
    expect(detail.body.totalMarks).toBe(20);
    expect(detail.body.questions.map((q: { position: number }) => q.position)).toEqual([1, 2, 3]);
  });

  it('rejects invalid questions', async () => {
    const exam = await newExam();
    const add = (body: object) =>
      ctx.http().post(`/exams/${exam.id}/questions`).set(auth(trainer)).send(body).expect(400);
    await add({ ...single, correctOptions: [0, 1] }); // two answers on a single question
    await add({ ...single, correctOptions: [5] }); // option does not exist
    await add({ ...single, options: ['only one'], correctOptions: [0] });
    await add({ ...single, negativeMarks: 9 }); // more than the marks
    await add({ ...single, type: 'MULTI', correctOptions: [1] }); // multi needs two
    await add({ ...single, type: 'CODING' }); // not available yet
    await add({ ...single, body: '   ' });
  });

  it('edits a question and ignores stale choice data when it becomes subjective', async () => {
    const exam = await newExam();
    const q = await ctx
      .http()
      .post(`/exams/${exam.id}/questions`)
      .set(auth(trainer))
      .send(single)
      .expect(201);
    const res = await ctx
      .http()
      .put(`/exams/${exam.id}/questions/${q.body.id}`)
      .set(auth(trainer))
      .send({ type: 'SUBJECTIVE', body: 'Describe HTTPS', marks: 5 })
      .expect(200);
    expect(res.body).toMatchObject({ type: 'SUBJECTIVE', options: [], correctOptions: [] });
  });

  it('cannot touch a question through another exam', async () => {
    const a = await newExam();
    const b = await newExam();
    const q = await ctx
      .http()
      .post(`/exams/${a.id}/questions`)
      .set(auth(trainer))
      .send(single)
      .expect(201);
    await ctx
      .http()
      .put(`/exams/${b.id}/questions/${q.body.id}`)
      .set(auth(trainer))
      .send(single)
      .expect(404);
    await ctx.http().delete(`/exams/${b.id}/questions/${q.body.id}`).set(auth(trainer)).expect(404);
  });

  it('renumbers after a delete and reorders', async () => {
    const exam = await newExam();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const r = await ctx
        .http()
        .post(`/exams/${exam.id}/questions`)
        .set(auth(trainer))
        .send({ ...single, body: `Question ${n}` })
        .expect(201);
      ids.push(r.body.id);
    }
    await ctx.http().delete(`/exams/${exam.id}/questions/${ids[0]}`).set(auth(trainer)).expect(204);
    let detail = await ctx.http().get(`/exams/${exam.id}`).set(auth(trainer)).expect(200);
    expect(detail.body.questions.map((q: { position: number }) => q.position)).toEqual([1, 2]);

    const reordered = await ctx
      .http()
      .put(`/exams/${exam.id}/questions-order`)
      .set(auth(trainer))
      .send({ questionIds: [ids[2], ids[1]] })
      .expect(200);
    expect(reordered.body.map((q: { body: string }) => q.body)).toEqual([
      'Question 3',
      'Question 2',
    ]);

    // missing, duplicate or foreign ids are refused
    await ctx
      .http()
      .put(`/exams/${exam.id}/questions-order`)
      .set(auth(trainer))
      .send({ questionIds: [ids[2]] })
      .expect(400);
    await ctx
      .http()
      .put(`/exams/${exam.id}/questions-order`)
      .set(auth(trainer))
      .send({ questionIds: [ids[2], ids[2]] })
      .expect(400);
    detail = await ctx.http().get(`/exams/${exam.id}`).set(auth(trainer)).expect(200);
    expect(detail.body.questionCount).toBe(2);
  });
});

describe('bulk import', () => {
  const text = `Question 1: What is 2+2?
A. 3
B. 4
C. 5
Answer: B

Question 2: Pick the primes
A. 2
B. 3
C. 4
Answer: A, B`;

  it('previews without saving, then commits', async () => {
    const exam = await newExam();
    const url = `/exams/${exam.id}/questions-import`;
    const preview = await ctx
      .http()
      .post(url)
      .set(auth(trainer))
      .send({ text, defaultMarks: 2 })
      .expect(200);
    expect(preview.body).toMatchObject({ committed: false, found: 2 });
    expect(preview.body.questions[1].type).toBe('MULTI');
    expect(await ctx.prisma.question.count()).toBe(0);

    const done = await ctx
      .http()
      .post(url)
      .set(auth(trainer))
      .send({ text, defaultMarks: 2, defaultNegativeMarks: 0.5, commit: true })
      .expect(200);
    expect(done.body.committed).toBe(true);
    const detail = await ctx.http().get(`/exams/${exam.id}`).set(auth(trainer)).expect(200);
    expect(detail.body.questionCount).toBe(2);
    expect(detail.body.totalMarks).toBe(4);
    expect(detail.body.questions[0]).toMatchObject({
      marks: 2,
      negativeMarks: 0.5,
      correctOptions: [1],
    });
  });

  it('rejects text with no questions', async () => {
    const exam = await newExam();
    await ctx
      .http()
      .post(`/exams/${exam.id}/questions-import`)
      .set(auth(trainer))
      .send({ text: 'just some words' })
      .expect(400);
  });

  it('enforces the 300-question limit', async () => {
    const exam = await newExam();
    const many = Array.from(
      { length: 301 },
      (_, i) => `Question ${i + 1}: Q${i + 1}?\nA. a\nB. b\nAnswer: A`,
    ).join('\n\n');
    await ctx
      .http()
      .post(`/exams/${exam.id}/questions-import`)
      .set(auth(trainer))
      .send({ text: many, commit: true })
      .expect(400);
    expect(await ctx.prisma.question.count()).toBe(0);
  });
});

describe('student preview', () => {
  it('never leaks answers, explanations or rubrics', async () => {
    const exam = await newExam();
    await ctx
      .http()
      .post(`/exams/${exam.id}/questions`)
      .set(auth(trainer))
      .send(single)
      .expect(201);
    await ctx
      .http()
      .post(`/exams/${exam.id}/questions`)
      .set(auth(trainer))
      .send({ type: 'SUBJECTIVE', body: 'Explain TLS', marks: 5, rubric: 'SECRET RUBRIC' })
      .expect(201);
    const res = await ctx.http().get(`/exams/${exam.id}/preview`).set(auth(trainer)).expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('correctOptions');
    expect(raw).not.toContain('TLS runs on 443');
    expect(raw).not.toContain('SECRET RUBRIC');
    expect(res.body.questions[0].options).toEqual(['80', '443', '22']);
    expect(res.body.totalMarks).toBe(9);
  });
});

describe('logo', () => {
  it('stores a PNG privately, serves it to the owner only, and replaces it', async () => {
    const exam = await newExam();
    const put = () =>
      ctx.http().put(`/exams/${exam.id}/logo`).set(auth(trainer)).attach('file', PNG, 'logo.png');
    await put().expect(200);
    const detail = await ctx.http().get(`/exams/${exam.id}`).set(auth(trainer)).expect(200);
    expect(detail.body.hasLogo).toBe(true);

    const img = await ctx.http().get(`/exams/${exam.id}/logo`).set(auth(trainer)).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    await ctx.http().get(`/exams/${exam.id}/logo`).set(auth(other)).expect(404);
    await ctx.http().get(`/exams/${exam.id}/logo`).expect(401);

    const first = (await ctx.prisma.exam.findUnique({ where: { id: exam.id } }))!.logoKey;
    await put().expect(200);
    const second = (await ctx.prisma.exam.findUnique({ where: { id: exam.id } }))!.logoKey;
    expect(second).not.toBe(first);

    await ctx.http().delete(`/exams/${exam.id}/logo`).set(auth(trainer)).expect(204);
    await ctx.http().get(`/exams/${exam.id}/logo`).set(auth(trainer)).expect(404);
  });

  it('rejects non-images (even when labelled as images), SVG and oversized files', async () => {
    const exam = await newExam();
    const attach = (data: Buffer, name: string, type: string) =>
      ctx
        .http()
        .put(`/exams/${exam.id}/logo`)
        .set(auth(trainer))
        .attach('file', data, { filename: name, contentType: type });
    await attach(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'a.svg',
      'image/svg+xml',
    ).expect(400);
    await attach(Buffer.from('MZ not an image'), 'a.png', 'image/png').expect(400);
    await attach(Buffer.concat([PNG, Buffer.alloc(700 * 1024)]), 'big.png', 'image/png').expect(
      413,
    );
    await ctx.http().put(`/exams/${exam.id}/logo`).set(auth(trainer)).expect(400);
  });
});

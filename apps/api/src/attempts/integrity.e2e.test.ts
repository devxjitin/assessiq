import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestContext, createTestApp, signUp } from '../../test/helpers';
import { PublishedExam, auth, joinExam, newStudent, publishExam } from '../../test/scenario';

let ctx: TestContext;
let trainer: { accessToken: string };
let sam: { accessToken: string };
let exam: PublishedExam;
let enrollmentId: string;

const DEV_A = 'device-aaaaaaaaaaaaaaaa';
const DEV_B = 'device-bbbbbbbbbbbbbbbb';

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

const start = (who: { accessToken: string }, enrollment: string, device?: string) => {
  const r = ctx.http().post('/attempts').set(auth(who)).set('User-Agent', 'Mozilla/5.0 (test)');
  if (device) r.set('X-Device-Id', device);
  return r.send({ enrollmentId: enrollment });
};
const view = (who: { accessToken: string }, id: string, device?: string) => {
  const r = ctx.http().get(`/attempts/${id}`).set(auth(who));
  if (device) r.set('X-Device-Id', device);
  return r;
};
const detail = async (attemptId: string) =>
  (await ctx.http().get(`/exams/${exam.examId}/attempts/${attemptId}`).set(auth(trainer))).body;

describe('one device per attempt', () => {
  beforeEach(async () => {
    exam = await publishExam(ctx, trainer);
    enrollmentId = await joinExam(ctx, sam, exam.code);
  });

  it('binds the first device and refuses another one', async () => {
    const a = (await start(sam, enrollmentId, DEV_A).expect(200)).body;
    await view(sam, a.id, DEV_A).expect(200);
    const refused = await view(sam, a.id, DEV_B).expect(403);
    expect(refused.body.code).toBe('DEVICE_MISMATCH');
    // writing from the other device is refused too
    await ctx
      .http()
      .put(`/attempts/${a.id}/answers/${exam.questionIds.single}`)
      .set(auth(sam))
      .set('X-Device-Id', DEV_B)
      .send({ selected: [0] })
      .expect(403);
    await ctx
      .http()
      .post(`/attempts/${a.id}/submit`)
      .set(auth(sam))
      .set('X-Device-Id', DEV_B)
      .expect(403);
    // an attempt that started on a device is not open to a client that hides its device either
    await view(sam, a.id).expect(403);
    // the real device keeps working, from a reload or a second tab
    await view(sam, a.id, DEV_A).expect(200);
    await start(sam, enrollmentId, DEV_A).expect(200);
    await start(sam, enrollmentId, DEV_B).expect(403);
  });

  it('records the blocked tries, and the trainer can release the attempt', async () => {
    const a = (await start(sam, enrollmentId, DEV_A).expect(200)).body;
    await view(sam, a.id, DEV_B).expect(403);
    await view(sam, a.id, DEV_B).expect(403);
    const events = await ctx.prisma.proctorEvent.findMany({ where: { attemptId: a.id } });
    // two quick tries are logged once, so the log stays readable
    expect(events.filter((e) => e.type === 'DEVICE_MISMATCH')).toHaveLength(1);
    expect(events[0].deviceId).toBe(DEV_B);

    const rows = (await ctx.http().get(`/exams/${exam.examId}/results`).set(auth(trainer))).body;
    expect(rows.rows[0].flags).toContain('DEVICE_MISMATCH');

    const other = await signUp(ctx, { role: 'EXAMINER', email: 'other-trainer@example.com' });
    await ctx
      .http()
      .post(`/exams/${exam.examId}/attempts/${a.id}/release-device`)
      .set(auth(other))
      .expect(404);
    await ctx
      .http()
      .post(`/exams/${exam.examId}/attempts/${a.id}/release-device`)
      .set(auth(sam))
      .expect(403);
    await ctx
      .http()
      .post(`/exams/${exam.examId}/attempts/${a.id}/release-device`)
      .set(auth(trainer))
      .expect(200);

    // the new device takes over, and the old one is now the stranger
    await view(sam, a.id, DEV_B).expect(200);
    await view(sam, a.id, DEV_A).expect(403);

    await ctx.http().post(`/attempts/${a.id}/submit`).set(auth(sam)).set('X-Device-Id', DEV_B);
    const d = await detail(a.id);
    expect(d.integrity.flags.map((f: { code: string }) => f.code)).toContain('DEVICE_MISMATCH');
    expect(d.events.some((e: { type: string }) => e.type === 'DEVICE_MISMATCH')).toBe(true);
  });

  it('lets a finished attempt be read from any device and cannot be released again', async () => {
    const a = (await start(sam, enrollmentId, DEV_A).expect(200)).body;
    await ctx
      .http()
      .post(`/attempts/${a.id}/submit`)
      .set(auth(sam))
      .set('X-Device-Id', DEV_A)
      .expect(200);
    await view(sam, a.id, DEV_B).expect(200);
    await ctx
      .http()
      .post(`/exams/${exam.examId}/attempts/${a.id}/release-device`)
      .set(auth(trainer))
      .expect(409);
  });

  it('ignores a malformed device id and flags the attempt for the trainer', async () => {
    const a = (await start(sam, enrollmentId, 'short').expect(200)).body;
    const stored = await ctx.prisma.attempt.findUniqueOrThrow({ where: { id: a.id } });
    expect(stored.deviceId).toBeNull();
    // the first request that does identify itself claims the attempt
    await view(sam, a.id, DEV_A).expect(200);
    await view(sam, a.id, DEV_B).expect(403);
  });

  it('keeps where the attempt was taken and when the network changed', async () => {
    const a = (await start(sam, enrollmentId, DEV_A).expect(200)).body;
    const stored = await ctx.prisma.attempt.findUniqueOrThrow({ where: { id: a.id } });
    expect(stored.startIp).toBeTruthy();
    expect(stored.userAgent).toBeTruthy();
    await ctx.prisma.attempt.update({ where: { id: a.id }, data: { startIp: '203.0.113.9' } });
    await ctx.http().post(`/attempts/${a.id}/submit`).set(auth(sam)).set('X-Device-Id', DEV_A);
    const d = await detail(a.id);
    expect(d.integrity.flags.map((f: { code: string }) => f.code)).toContain('NETWORK_CHANGED');
  });

  it('flags two students who used the same device', async () => {
    const lee = await newStudent(ctx, 'lee@example.com');
    const leeEnrollment = await joinExam(ctx, lee, exam.code);
    const a = (await start(sam, enrollmentId, DEV_A).expect(200)).body;
    const b = (await start(lee, leeEnrollment, DEV_A).expect(200)).body;
    for (const [who, id] of [
      [sam, a.id],
      [lee, b.id],
    ] as const) {
      await ctx.http().post(`/attempts/${id}/submit`).set(auth(who)).set('X-Device-Id', DEV_A);
    }
    const rows = (await ctx.http().get(`/exams/${exam.examId}/results`).set(auth(trainer))).body;
    expect(rows.rows.every((r: { flags: string[] }) => r.flags.includes('SHARED_DEVICE'))).toBe(
      true,
    );
    const d = await detail(a.id);
    expect(d.integrity.sharedWith).toHaveLength(1);
    expect(d.integrity.sharedWith[0].email).toBe('lee@example.com');
  });
});

describe('question pools', () => {
  const SINGLE = {
    type: 'SINGLE',
    body: 'Pool question',
    options: ['yes', 'no'],
    correctOptions: [0],
    marks: 4,
  };

  it('gives each student a random subset and keeps the others hidden', async () => {
    exam = await publishExam(ctx, trainer, { questionsPerStudent: 2 }, [SINGLE, SINGLE, SINGLE]);
    const all = new Set([
      exam.questionIds.single,
      exam.questionIds.multi,
      exam.questionIds.subjective,
      ...exam.extraIds,
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const s = await newStudent(ctx, `pool${i}@example.com`);
      const e = await joinExam(ctx, s, exam.code);
      const a = (await start(s, e, DEV_A).expect(200)).body;
      expect(a.questions).toHaveLength(2);
      expect(a.questions.map((q: { number: number }) => q.number)).toEqual([1, 2]);
      const ids = a.questions.map((q: { id: string }) => q.id);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) {
        expect(all.has(id)).toBe(true);
        seen.add(id);
      }
      const notGiven = [...all].find((q) => !ids.includes(q))!;
      await ctx
        .http()
        .put(`/attempts/${a.id}/answers/${notGiven}`)
        .set(auth(s))
        .set('X-Device-Id', DEV_A)
        .send({ selected: [0] })
        .expect(404);
    }
    // six students and six questions: it is not the same pair for everybody
    expect(seen.size).toBeGreaterThan(2);
  });

  it('marks only the questions a student was given', async () => {
    exam = await publishExam(ctx, trainer, { questionsPerStudent: 1 });
    const a = (
      await start(sam, (enrollmentId = await joinExam(ctx, sam, exam.code)), DEV_A).expect(200)
    ).body;
    // make the pool deterministic: this student got the single-choice question (2 marks)
    await ctx.prisma.attempt.update({
      where: { id: a.id },
      data: { questionOrder: [exam.questionIds.single] },
    });
    await ctx
      .http()
      .put(`/attempts/${a.id}/answers/${exam.questionIds.single}`)
      .set(auth(sam))
      .set('X-Device-Id', DEV_A)
      .send({ selected: [0] })
      .expect(200);
    await ctx
      .http()
      .post(`/attempts/${a.id}/submit`)
      .set(auth(sam))
      .set('X-Device-Id', DEV_A)
      .expect(200);

    // the written question was never given, so nothing is waiting for the trainer
    const stored = await ctx.prisma.attempt.findUniqueOrThrow({ where: { id: a.id } });
    expect(stored.status).toBe('GRADED');
    expect(stored.score).toBe(2);
    expect(stored.maxScore).toBe(2);
    expect(stored.percent).toBe(100);

    const d = await detail(a.id);
    expect(d.pooled).toBe(true);
    expect(d.questions).toHaveLength(1);
    await ctx
      .http()
      .put(`/exams/${exam.examId}/attempts/${a.id}/answers/${exam.questionIds.subjective}/grade`)
      .set(auth(trainer))
      .send({ marks: 1 })
      .expect(404);

    const results = (await ctx.http().get(`/exams/${exam.examId}/results`).set(auth(trainer))).body;
    expect(results.exam.questionsPerStudent).toBe(1);
    expect(results.rows[0].maxScore).toBe(2);
    const csv = (await ctx.http().get(`/exams/${exam.examId}/results.csv`).set(auth(trainer))).text;
    expect(csv).toContain(',2,2,100,');
  });

  it('cannot be larger than the exam when publishing', async () => {
    const draft = await ctx
      .http()
      .post('/exams')
      .set(auth(trainer))
      .send({
        title: 'Too big a pool',
        durationMinutes: 30,
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000 * 3).toISOString(),
        questionsPerStudent: 5,
      })
      .expect(201);
    await ctx
      .http()
      .post(`/exams/${draft.body.id}/questions`)
      .set(auth(trainer))
      .send(SINGLE)
      .expect(201);
    const res = await ctx
      .http()
      .post(`/exams/${draft.body.id}/publish-order`)
      .set(auth(trainer))
      .expect(400);
    expect(res.body.message).toContain('Questions per student');
    await ctx
      .http()
      .patch(`/exams/${draft.body.id}`)
      .set(auth(trainer))
      .send({ questionsPerStudent: null })
      .expect(200);
    await ctx.http().post(`/exams/${draft.body.id}/publish-order`).set(auth(trainer)).expect(200);
  });

  it('shows students the pool size before they pay', async () => {
    exam = await publishExam(ctx, trainer, { questionsPerStudent: 2 });
    const info = (await ctx.http().get(`/join/${exam.code}`).set(auth(sam)).expect(200)).body;
    expect(info.questionCount).toBe(2);
  });
});

describe('guessing exam codes', () => {
  it('pauses a student after too many wrong codes, but not other students', async () => {
    exam = await publishExam(ctx, trainer);
    for (let i = 0; i < 8; i++) {
      await ctx.http().get(`/join/WRONG-${i}`).set(auth(sam)).expect(404);
    }
    await ctx.http().get(`/join/WRONG-9`).set(auth(sam)).expect(429);
    // even the right code waits
    await ctx.http().get(`/join/${exam.code}`).set(auth(sam)).expect(429);
    const lee = await newStudent(ctx, 'lee@example.com');
    await ctx.http().get(`/join/${exam.code}`).set(auth(lee)).expect(200);
  });

  it('does not count right codes against the student', async () => {
    exam = await publishExam(ctx, trainer);
    for (let i = 0; i < 12; i++) {
      await ctx.http().get(`/join/${exam.code}`).set(auth(sam)).expect(200);
    }
  });
});

describe('copied code', () => {
  const CODING = {
    type: 'CODING',
    body: 'Sum the numbers.',
    marks: 10,
    coding: {
      languages: ['python'],
      starterCode: { python: '# write your code here\n' },
      timeLimitMs: 2000,
      memoryMb: 256,
      testCases: [{ input: '1 2', expectedOutput: '3', hidden: false, weight: 1 }],
    },
  };
  const ORIGINAL = `
import sys

def read_numbers():
    data = sys.stdin.read().split()
    return [int(x) for x in data]

def total(values):
    result = 0
    for value in values:
        if value > 0:
            result += value
        else:
            result += value
    return result

numbers = read_numbers()
print(total(numbers))
`;
  // same program, other names, spacing and comments
  const DISGUISED = `
import sys
# my solution

def get_input():
    raw = sys.stdin.read().split()
    return [int(item) for item in raw]


def add_up(nums):
    acc = 0
    for n in nums:
        if n > 0:
            acc += n
        else:
            acc += n
    return acc

lst = get_input()
print(add_up(lst))
`;
  const DIFFERENT = `
import sys
from functools import reduce

line = sys.stdin.readline()
parts = line.strip().split(" ")
answer = reduce(lambda x, y: x + y, map(int, parts), 0)
sys.stdout.write(str(answer) + "\\n")
`;

  async function submitCode(email: string, source: string) {
    const s = await newStudent(ctx, email);
    const e = await joinExam(ctx, s, exam.code);
    const a = (await start(s, e, DEV_A).expect(200)).body;
    await ctx
      .http()
      .put(`/attempts/${a.id}/answers/${exam.extraIds[0]}`)
      .set(auth(s))
      .set('X-Device-Id', DEV_A)
      .send({ text: source, language: 'python' })
      .expect(200);
    await ctx
      .http()
      .post(`/attempts/${a.id}/submit`)
      .set(auth(s))
      .set('X-Device-Id', DEV_A)
      .expect(200);
    return a.id as string;
  }

  it('reports the pair that is alike, even with renamed variables, and not the rest', async () => {
    exam = await publishExam(ctx, trainer, {}, [CODING]);
    const first = await submitCode('ann@example.com', ORIGINAL);
    const second = await submitCode('bob@example.com', DISGUISED);
    await submitCode('cat@example.com', DIFFERENT);

    const report = (
      await ctx.http().get(`/exams/${exam.examId}/similarity`).set(auth(trainer)).expect(200)
    ).body;
    expect(report.questions).toHaveLength(1);
    const q = report.questions[0];
    expect(q.compared).toBe(3);
    expect(q.pairs).toHaveLength(1);
    const ids = [q.pairs[0].a.attemptId, q.pairs[0].b.attemptId].sort();
    expect(ids).toEqual([first, second].sort());
    expect(q.pairs[0].similarity).toBeGreaterThanOrEqual(80);
  });

  it('only for the trainer who owns the exam', async () => {
    exam = await publishExam(ctx, trainer, {}, [CODING]);
    const other = await signUp(ctx, { role: 'EXAMINER', email: 'other@example.com' });
    await ctx.http().get(`/exams/${exam.examId}/similarity`).set(auth(other)).expect(404);
    await ctx.http().get(`/exams/${exam.examId}/similarity`).set(auth(sam)).expect(403);
    await ctx.http().get(`/exams/${exam.examId}/similarity`).expect(401);
  });

  it('does not count the starter code, empty answers or tiny programs', async () => {
    exam = await publishExam(ctx, trainer, {}, [CODING]);
    await submitCode('ann@example.com', '# write your code here\n');
    await submitCode('bob@example.com', '# write your code here\n');
    await submitCode('cat@example.com', 'print(1)');
    await submitCode('dan@example.com', 'print(1)');
    const q = (
      await ctx.http().get(`/exams/${exam.examId}/similarity`).set(auth(trainer)).expect(200)
    ).body.questions[0];
    expect(q.pairs).toHaveLength(0);
    expect(q.compared).toBe(0);
  });
});

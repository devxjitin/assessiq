// k6 load test: N students sign in, start the exam, autosave every ~10 seconds, then submit.
// Read docs/LOAD_TEST.md first. Never point this at production.
//
//   k6 run -e BASE_URL=https://api-staging.example.com -e PASSWORD='...' load/exam-load.js
//
// Optional: STUDENTS (500), EXAM_SECONDS (120; use 1800 for a real run), RAMP_SECONDS (60),
// SAVE_EVERY_SECONDS (10).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL;
const PASSWORD = __ENV.PASSWORD;
const STUDENTS = Number(__ENV.STUDENTS || 500);
const EXAM_SECONDS = Number(__ENV.EXAM_SECONDS || 120);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 60);
const SAVE_EVERY = Number(__ENV.SAVE_EVERY_SECONDS || 10);
// The access token lasts 15 minutes; renew it before that on long runs.
const REFRESH_AFTER_MS = 12 * 60 * 1000;

if (!BASE || !PASSWORD) {
  throw new Error('Set BASE_URL and PASSWORD (see docs/LOAD_TEST.md)');
}
// Staging hostnames contain "staging" (api-staging.<domain>). Anything else needs a deliberate override.
if (!/staging|localhost|127\.0\.0\.1/i.test(BASE) && __ENV.NOT_PRODUCTION !== 'yes') {
  throw new Error(
    'BASE_URL does not look like staging. Load tests never run against production. ' +
      'If this is a throwaway environment, add -e NOT_PRODUCTION=yes.',
  );
}

export const options = {
  scenarios: {
    students: {
      executor: 'per-vu-iterations',
      vus: STUDENTS,
      iterations: 1,
      maxDuration: `${RAMP_SECONDS + EXAM_SECONDS + 300}s`,
    },
  },
  thresholds: {
    // The launch target from the plan: autosave P95 under 500 ms with 500 students.
    'http_req_duration{name:autosave}': ['p(95)<500'],
    'http_req_duration{name:start_attempt}': ['p(95)<1500'],
    'http_req_duration{name:submit}': ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default function () {
  // One virtual user is one student. The seed script made load-student-0001 ... N.
  const email = `load-student-${String(__VU).padStart(4, '0')}@loadtest.invalid`;
  sleep(Math.random() * RAMP_SECONDS); // students do not all arrive in the same second

  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: JSON_HEADERS,
    tags: { name: 'login' },
  });
  if (!check(login, { 'login 200': (r) => r.status === 200 })) return;
  let token = login.json('accessToken');
  let tokenAt = Date.now();
  const authed = () => ({
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });

  const enrollments = http.get(`${BASE}/me/enrollments`, {
    ...authed(),
    tags: { name: 'enrollments' },
  });
  const enrollmentId = enrollments.json('0.enrollmentId');
  if (!check(enrollments, { 'has enrollment': () => Boolean(enrollmentId) })) return;

  const start = http.post(`${BASE}/attempts`, JSON.stringify({ enrollmentId }), {
    ...authed(),
    tags: { name: 'start_attempt' },
  });
  if (!check(start, { 'attempt started': (r) => r.status === 200 })) return;
  const attemptId = start.json('id');

  const state = http.get(`${BASE}/attempts/${attemptId}`, {
    ...authed(),
    tags: { name: 'load_attempt' },
  });
  const questions = (state.json('questions') || []).map((q) => q.id);
  if (!check(state, { 'has questions': () => questions.length > 0 })) return;

  // The real page saves a changed answer about every 10 seconds, with a rising counter.
  let seq = 0;
  const endAt = Date.now() + EXAM_SECONDS * 1000;
  while (Date.now() < endAt) {
    sleep(SAVE_EVERY + (Math.random() * 2 - 1));
    if (Date.now() - tokenAt > REFRESH_AFTER_MS) {
      const renewed = http.post(`${BASE}/auth/refresh`, null, { tags: { name: 'refresh' } });
      if (renewed.status === 200) {
        token = renewed.json('accessToken');
        tokenAt = Date.now();
      }
    }
    seq += 1;
    const question = questions[Math.floor(Math.random() * questions.length)];
    const saved = http.put(
      `${BASE}/attempts/${attemptId}/answers/${question}`,
      JSON.stringify({ selected: [Math.floor(Math.random() * 4)], seq }),
      { ...authed(), tags: { name: 'autosave' } },
    );
    check(saved, { 'autosave 200': (r) => r.status === 200 });
  }

  const submit = http.post(`${BASE}/attempts/${attemptId}/submit`, '{}', {
    ...authed(),
    tags: { name: 'submit' },
  });
  check(submit, { 'submit 200': (r) => r.status === 200 });
}

# Load test: 500 students in one exam

**Status: tooling written and tested locally; the test has NOT been run.** No results exist yet. The numbers below are targets, not measurements.

## Target

500 students sign in over about a minute, start the exam, and each autosaves an answer roughly every 10 seconds for the whole exam, then submits. **P95 of autosave under 500 ms**, under 1% failed requests, and no student loses an answer.

## What you need

| Need                                                                                                                           | Who                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| [k6](https://k6.io/docs/get-started/installation/) installed on the machine that generates load                                | You (not installed here) |
| A staging environment you may load: shared, so pick a time with no real exam                                                   | You                      |
| A way to run the seed script where it can reach the staging database (the database is private, so on the app host through SSM) | You                      |
| Raising the per-IP rate-limit ceilings on staging for the test (see below)                                                     | You                      |

Run it from a stable connection. A home Wi-Fi link can be the bottleneck instead of the server; if numbers look bad, repeat from a small cloud machine in the same region.

## Rate limits (read this first)

The API limits requests per IP address, and a load generator is a single IP. The ceilings are high by default so a classroom behind one college network can sign in together, but a 500-student test from one machine can still reach them, and then the test would measure refusals (HTTP 429) instead of capacity.

| Setting (environment)           | Default | What it caps, per IP per minute                                    |
| ------------------------------- | ------- | ------------------------------------------------------------------ |
| `RATE_LIMIT_IP_PER_MIN`         | 1200    | Everything not listed below                                        |
| `RATE_LIMIT_LOGIN_IP_PER_MIN`   | 600     | Sign-in, code entry                                                |
| `RATE_LIMIT_REFRESH_IP_PER_MIN` | 600     | Session renewal                                                    |
| `RATE_LIMIT_SIGNUP_IP_PER_MIN`  | 120     | Routes that send an email (register, resend code, forgot password) |
| `RATE_LIMIT_LOOKUP_IP_PER_MIN`  | 300     | Exam-code and sponsored-seat lookups                               |

Exam routes (`/attempts/...`: start, autosave, submit, proctoring events) are exempt from the IP limit; they are limited to 240 per minute per **user** instead.

The real protection is per account, not per IP, and it stays on during the test: sign-in and code entry allow 10 tries a minute for one email from one network, and routes that send mail allow 5 a minute to one address from anywhere. The k6 script signs each student in once, so these do not get in the way.

**For the load test, raise the ceilings on staging first.** Set the five `RATE_LIMIT_*` parameters in SSM under `/assessiq/staging/` to a large number (for example `100000`), deploy, run the test, then delete the parameters and deploy again so staging goes back to the defaults. Do not leave them raised. (If you would rather not touch staging, run k6 from several machines.)

## Steps

### 1. Create the test students and exam (on the app host)

The seed script writes straight to the database, so no emails or payments are involved. Everything it makes uses the address domain `loadtest.invalid`, and `--cleanup` removes exactly that.

It refuses to run unless you pass `--yes` **and** set `LOAD_SEED_TARGET` to the database host it is about to change, so it cannot hit the wrong database by accident. **Never run it against production.**

From the repository (for example locally against a database you own):

```bash
cd assessiq
npm run build -w @assessiq/api
LOAD_SEED_TARGET=<database host> npm run seed:load -w @assessiq/api -- --yes --students 500 --minutes 30
```

It prints the exam code and the one password all test students share. On staging, run the same compiled script (`dist/scripts/seed-load-test.js`) inside the API container on the app host with that container's `DATABASE_URL`. **NOT YET DRILLED:** confirm the path inside the image the first time you do this.

### 2. Run k6

```bash
k6 run \
  -e BASE_URL=https://api-staging.<your-domain> \
  -e PASSWORD='<the password the seed printed>' \
  -e STUDENTS=500 -e EXAM_SECONDS=1800 -e RAMP_SECONDS=60 \
  load/exam-load.js
```

The script refuses a `BASE_URL` that does not contain "staging" or "localhost" (override only for a throwaway environment with `-e NOT_PRODUCTION=yes`). Start with a smoke run: `-e STUDENTS=20 -e EXAM_SECONDS=120`, then 100, then 500.

### 3. Watch while it runs

- EC2 CPU and memory (`docker stats` on the host).
- RDS CPU and `DatabaseConnections` (the database is a small `db.t4g.micro` by default; watch for connection exhaustion).
- API logs: `docker compose --env-file .deploy.env logs -f api`. In production each request is one JSON line with its duration in `ms`, and unexpected errors appear as `unhandled error` lines.

### 4. Clean up (always)

```bash
LOAD_SEED_TARGET=<database host> npm run seed:load -w @assessiq/api -- --yes --cleanup
```

This removes the test students, their attempts and answers, the load-test trainer and the exam, and nothing else.

### 5. Record the result

| Date          | Students | Exam length | Autosave P95 | Start-attempt P95 | Submit P95 | Failed requests | Peak EC2 CPU | Peak RDS CPU | Peak DB connections | Notes |
| ------------- | -------- | ----------- | ------------ | ----------------- | ---------- | --------------- | ------------ | ------------ | ------------------- | ----- |
| (not run yet) |          |             |              |                   |            |                 |              |              |                     |       |

## If it is too slow

Fix what the measurement shows, not what looks likely. The plan proposed caching each exam's questions for 60 seconds, but that is only worth doing if loading the exam is the slow part; a cache also has to be cleared when a trainer corrects a question after publishing, or students could see a stale question. Things to look at first: the database connection pool size against the instance size, the slowest request names in the k6 summary, and database CPU. One more thing worth knowing: all students hit the same autosave route, so look for lock contention on `Answer` rows only if a few students are slow, not all.

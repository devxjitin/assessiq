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
| The rate-limit decision below                                                                                                  | You                      |

Run it from a stable connection. A home Wi-Fi link can be the bottleneck instead of the server; if numbers look bad, repeat from a small cloud machine in the same region.

## Rate limits (read this first)

The API limits requests **per IP address**, and a load generator is a single IP, so the test will measure rate-limit refusals (HTTP 429) instead of capacity unless this is handled:

| Route                                                                     | Limit                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /auth/login`                                                        | 10 per minute per IP                                                     |
| `POST /auth/refresh`                                                      | 30 per minute per IP                                                     |
| `GET /join/:code`                                                         | 30 per minute per IP                                                     |
| Everything else (for example `GET /me/enrollments`)                       | 120 per minute per IP                                                    |
| Exam routes (`/attempts/...`: start, autosave, submit, proctoring events) | Exempt from the IP limit; limited to 240 per minute per **user** instead |

**This is also a real-world problem, not only a testing one.** Students in one classroom or college usually share one public IP. With a 10-per-minute sign-in limit, 30 students sitting down together cannot all sign in during the first minute, and a campus of 500 would hit the token-refresh limit (30 per minute) mid-exam. The autosave path is fine, because it is exempt. **Decision needed before launch:** raise or restructure the per-IP limits on sign-in, refresh and enrollment lookup (for example per-account limits plus a much higher per-IP ceiling), and make the numbers configurable so staging can be relaxed for this test. Until then the load test can only be run from many IPs, or against a staging copy with the limits raised.

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

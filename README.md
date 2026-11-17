# AssessIQ

Online assessments and verified certificates by NandiVex Technologies.
Plan: [ASSESSIQ_IMPLEMENTATION_PLAN.md](ASSESSIQ_IMPLEMENTATION_PLAN.md). Legacy app: the parent folder (Exam Hall).

## Layout

```
apps/
  web/      Next.js (student, examiner, admin UI)
  api/      NestJS REST API
  worker/   BullMQ consumers (code grading, certificate PDFs, email)
packages/
  shared/           Constants (prices, limits), enums, money/split helpers
  question-parser/  Bulk question import (ported from Exam Hall) + tests
infra/      docker-compose (local) + AWS checklist/Terraform
```

## Getting started

Requires Node 20+ (tested on Node 26) and Docker (for Postgres/Redis).

```bash
npm install
cp .env.example .env
npm run infra:up        # Postgres + Redis
npm run build           # builds shared packages first, then apps
npm test
npm run dev:api         # http://localhost:4000/health
npm run dev:web         # http://localhost:3000
npm run dev:worker
```

## Conventions

- Money is always integer **paise**. Use `splitGross` for the 50/50 split.
- Prices and limits live in `packages/shared/src/constants.ts`, not scattered in code.
- Never commit `.env` or secrets (see `.env.example`).

## Not yet done (Sprint 0 remainder)

Still open from Sprint 0: ESLint and commit hooks, design system and wireframes, production Terraform apply, working GitHub Actions (blocked by billing). See the plan file for full status.

## Sprint 9: certificates (done locally)

- **Two certificates:** students get a Certificate of Achievement (or Participation); the trainer gets a Certificate of Appreciation for conducting the exam. Samples of both are on the landing page (`apps/web/public/samples/`, regenerate with the renderer if the design changes).
- **Trainer:** exam **Certificate** tab (layout, colour, wording, signatory, live PDF preview). When results are published, one certificate is made per eligible student (achievement at or above the pass mark, participation below).
- **Admin:** `/admin/certificates` queue: preview, approve (per exam or selected), reject with a reason, resend. API under `/admin/certificates/*`.
- **Students:** emailed the PDF after approval; download from the dashboard (`GET /certificates/mine`, `/certificates/:id/pdf`).
- **Public:** `/verify/?serial=AIQ-XXXX-XXXX-XXXX` (`GET /verify/:serial`), no sign-in, no scores.
- **Background jobs:** `CERT_JOBS_POLL=on|off` (make PDFs, send approved certificates).
- **Bounces:** `POST /mail/ses-events?key=$SES_EVENTS_KEY` for AWS SNS; Terraform `ses_events_endpoint` creates the subscription.

## Sprint 8: money (done locally)

- **Ledger:** every payment is booked in a balanced double-entry ledger (`EXTERNAL`, `PLATFORM`, `EXAMINER:<id>`, `PAYOUTS`). Join fee: 50% trainer, 50% NandiVex. Sponsored seats and publishing fees: all NandiVex.
- **Trainer:** `/earnings` (accruing, payable, requested, paid), payout details (UPI or bank, account number encrypted), `POST /payouts/request`, CSV statements.
- **Admin:** `/admin/payouts` (pay with UTR, reject, direct payout, ledger check) and `/admin/payments` (search and refund). API under `/admin/finance/*`.
- **Sponsored seats:** `POST /exams/:id/seats/order`, `GET|POST /exams/:id/seats[/assign]`, student `GET /seats/preview`, `POST /seats/redeem`; link `/redeem/?token=...`.
- **Config:** `DATA_ENCRYPTION_KEY` (32+ characters) encrypts bank account numbers; falls back to `OTP_SECRET`. Do not change it once trainers have saved details.

## Sprint 7: exam integrity (done locally)

- **Question pools:** exam setting *Questions per student*; each student gets a random N of the questions and is marked out of those.
- **One device per attempt:** the browser's device id (header `X-Device-Id`) is bound to a running attempt; another device gets `403 DEVICE_MISMATCH` until the trainer uses **Release device** (`POST /exams/:id/attempts/:attemptId/release-device`).
- **Integrity report:** results table badges, and a report plus event timeline (with IPs) on the marking screen.
- **Join-code limiter:** 8 wrong codes in 10 minutes pauses that student's lookups.
- **Copied code check:** `GET /exams/:id/similarity?threshold=0.8` (trainer), shown on the results tab.

## Sprint 6: coding questions (done locally)

- **Question type:** _Coding_ in the exam builder: statement, languages (Python, C, C++, Java, JavaScript), starter code, time and memory limits, test cases that are _sample_ (shown, runnable) or _hidden_ (grading only), each with a weight.
- **Students:** write code, **Run on samples** (one run per 3 s, 40 per question), submit. After the exam, the judge runs every test; marks = question marks x passed weight / total weight.
- **API:** `POST /attempts/:id/questions/:questionId/run`; the trainer marks screen can override coding marks like any written answer.
- **Config:** `CODE_RUNNER=judge0|fake|disabled` (default `disabled`), `JUDGE0_URL`, `JUDGE0_AUTH_TOKEN`, `JUDGE0_LIMIT_MODE=process|cgroup`, `CODE_JUDGE_POLL=on|off`, `CODE_JUDGE_CONCURRENCY`. `fake` returns canned results for tests and demos.
- **Run Judge0 locally:** see `infra/judge0/docker-compose.yml` (`docker compose -f infra/judge0/docker-compose.yml up -d`), then set `CODE_RUNNER=judge0 JUDGE0_URL=http://localhost:2358`.
- **Sandbox tests:** `LIVE_JUDGE0_URL=http://localhost:2358 npx vitest run src/code/judge0.live.test.ts` (in `apps/api`).
- **Production:** `infra/terraform/judge0.tf` creates a separate x86 host (off by default).

## Sprint 5: grading and results (done locally)

- **Marking:** choice questions are marked by the server when an attempt ends. Single answer: right = marks, wrong = minus the penalty, blank = 0. Multiple answer: the exact set earns the marks; with _partial credit_ on, picking only correct options earns a share; anything else costs the penalty. A total never drops below 0.
- **Trainer:** exam page, **Results** tab (stats, table, CSV export, publish) and `/exams/grade/?exam=&attempt=` to mark written answers. API: `GET /exams/:id/results`, `GET /exams/:id/results.csv`, `GET /exams/:id/attempts/:attemptId`, `PUT /exams/:id/attempts/:attemptId/answers/:questionId/grade`, `POST /exams/:id/finalize`.
- **Student:** `/result/?id=` (after the trainer publishes), `GET /attempts/:id/result`. Results and correct answers are never sent before publishing.
- **Publishing rules:** the exam must be closed, nobody still taking it, every written answer marked. Publishing locks all marks.

## Sprint 4: joining and taking exams (done locally)

- **Student flow:** `/join/` (enter a code, see the exam and the ₹149 fee, pay, enrolled) then the dashboard's **My exams** list, then `/attempt/?id=…` (full-screen exam with countdown, navigator, flagging, autosave).
- **API:** `GET /join/:code`, `POST /join/:code/order`, `GET /me/enrollments`, `POST /attempts`, `GET /attempts/:id`, `PUT /attempts/:id/answers/:questionId`, `POST /attempts/:id/submit`, `POST /attempts/:id/events`.
- **Rules:** the server owns the clock and the deadline; each student gets their own question and option order; correct answers are never sent to the browser; one attempt per enrollment; 3 strikes (leaving full screen, switching tab or window) auto-submit. Proctoring is advisory evidence, not proof.
- **Not yet:** grading and results (Sprint 5), a job that auto-submits abandoned attempts (Sprint 5).

## Sprint 3: publishing and payments (done, fake provider)

- **Flow:** the trainer opens the **Publish** tab, pays the creation fee (₹199), and the exam becomes `PUBLISHED` with a share code like `NVX-7K3P9Q` and an emailed receipt. Publishing needs at least one question and an open/close window that is in the future and at least as long as the exam.
- **API:** `POST /exams/:id/publish-order` (creates or resumes the order), `POST /payments/verify` (checks the gateway signature), `POST /payments/webhook` (gateway to server; signature-checked, safe to redeliver), `POST /payments/fake/complete` (fake provider only).
- **Safety rules:** the exam is only published by a captured payment; capturing is exactly-once whether the browser or the webhook arrives first; the webhook amount must match; a late "failed" event never downgrades a captured payment; a paid order whose exam was deleted is flagged in the audit log for a manual refund.
- **Providers:** `PAYMENT_PROVIDER=fake` (default) simulates the gateway and the web app shows a test-mode notice. `PAYMENT_PROVIDER=razorpay` uses the real API and needs `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`; the server refuses to start without them. Never run `fake` in production.
- **Webhook setup (Razorpay dashboard):** URL `https://<api host>/payments/webhook`, events `payment.captured` and `payment.failed`.

## Sprint 2: exam builder (done)

- **Trainer-only API** (`apps/api/src/exams`): create, edit and delete **draft** exams; single-answer, multiple-answer and subjective questions; reorder; bulk import from pasted text (check first, then import); private logo upload; "preview as student" that never includes answers, explanations or rubrics.
- **Rules:** a trainer only ever sees their own exams (others return 404); only `DRAFT` exams can be changed; at most 300 questions per exam; negative marks cannot exceed the marks for a correct answer.
- **Logo:** PNG or JPEG up to 512 KB, type checked from the file contents (SVG is refused). Stored in the private S3 files bucket and served only through the API to the owner. Locally and in tests it uses an in-memory store (`STORAGE_DRIVER=memory`); staging sets `STORAGE_DRIVER=s3`.
- **Web:** `/exams/` (list), `/exams/new/`, `/exams/edit/?id=…` (questions, import, settings, logo), `/exams/preview/?id=…`.
- **Not yet:** coding questions (Sprint 6).

## Sprint 1: identity (done)

- **API** (`apps/api`): register, email-code verification, login, refresh-token rotation with reuse detection, logout, password reset and change, profile, admin user list/suspend. Passwords use argon2id; failed logins lock the account for 15 minutes; auth routes are rate limited.
- **Access control:** a global JWT guard plus `@Roles()`; routes are private unless marked `@Public()`. Unverified emails cannot sign in, so they cannot reach any exam feature.
- **Database:** Prisma + Postgres (`apps/api/prisma`). Run `npm run db:migrate -w @assessiq/api` after pulling.
- **Tests:** `npm test` (needs Postgres from `npm run infra:up`; the API tests use the `assessiq_test` database).
- **First admin** (admins cannot self-register):
  `ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NAME=... npm run seed:admin -w @assessiq/api` (after `npm run build`).
- **Email:** `MAIL_TRANSPORT=log` prints codes to the console in development; `ses` sends real mail (SES sandbox only delivers to verified addresses until production access is approved).

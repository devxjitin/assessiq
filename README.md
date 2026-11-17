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

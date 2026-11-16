# AssessIQ

Online assessments and verified certificates by NandiVex Technologies.
Plan: [../ASSESSIQ_IMPLEMENTATION_PLAN.md](../ASSESSIQ_IMPLEMENTATION_PLAN.md). Legacy app: the parent folder (Exam Hall).

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

ESLint config, Prisma + migrations (Sprint 1), Terraform, deploy workflow, `git init` + remote.

## Sprint 1: identity (done)

- **API** (`apps/api`): register, email-code verification, login, refresh-token rotation with reuse detection, logout, password reset and change, profile, admin user list/suspend. Passwords use argon2id; failed logins lock the account for 15 minutes; auth routes are rate limited.
- **Access control:** a global JWT guard plus `@Roles()`; routes are private unless marked `@Public()`. Unverified emails cannot sign in, so they cannot reach any exam feature.
- **Database:** Prisma + Postgres (`apps/api/prisma`). Run `npm run db:migrate -w @assessiq/api` after pulling.
- **Tests:** `npm test` (needs Postgres from `npm run infra:up`; the API tests use the `assessiq_test` database).
- **First admin** (admins cannot self-register):
  `ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NAME=... npm run seed:admin -w @assessiq/api` (after `npm run build`).
- **Email:** `MAIL_TRANSPORT=log` prints codes to the console in development; `ses` sends real mail (SES sandbox only delivers to verified addresses until production access is approved).

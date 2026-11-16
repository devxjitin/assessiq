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

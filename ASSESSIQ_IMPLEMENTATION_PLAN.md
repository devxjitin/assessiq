# AssessIQ: Product Implementation Plan

**Company:** NandiVex Technologies
**Product:** AssessIQ, a paid online assessment and certification platform
**Based on:** the existing Exam Hall codebase (rebuilt into a secure platform; see [../PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md))
**Version:** 1.1 (16 Nov 2026): status updated after Sprint 0 and Sprint 1
**Repository:** https://github.com/devxjitin/assessiq
**Staging:** web https://app-staging.assessiq.nandivex.in · API https://api-staging.assessiq.nandivex.in

Legend: ✅ done · 🟡 partly done · ⬜ not started · ⛔ blocked

---

## Progress at a glance

| Phase         | Sprint                                             | Status                    | Notes                                                                                                                                                        |
| ------------- | -------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0 Foundation | **S0** Setup                                       | ✅ Done (with open items) | Monorepo, AWS staging, DNS/HTTPS, SES verified, deploy path proven. Open: GitHub Actions blocked by billing, Razorpay KYC, budget alerts, design/wireframes. |
| P1 Core MVP   | **S1** Identity                                    | ✅ Done, live on staging  | Accounts, email-code verification, login/refresh, password reset, roles, admin, audit log. 28 API tests.                                                     |
| P1 Core MVP   | **S2** Exam builder                                | ✅ Done, live on staging  | Draft exams, single/multi/subjective questions, bulk import, private logo, student preview. 19 new API tests.                                                |
| P1 Core MVP   | S3 Creation payments                               | ⬜ Next                   | Needs Razorpay account and test keys                                                                                                                         |
| P1 Core MVP   | S4 Join & take exam                                | ⬜                        |                                                                                                                                                              |
| P1 Core MVP   | S5 Grading & results                               | ⬜                        |                                                                                                                                                              |
| P2            | S6 Coding engine · S7 Integrity                    | ⬜                        |                                                                                                                                                              |
| P3            | S8 Ledger/payouts · S9 Certificates · S10 Practice | ⬜                        |                                                                                                                                                              |
| P4            | S11 Admin & migration · S12 Launch                 | ⬜                        |                                                                                                                                                              |

**Sprints done: 3 of 13 (S0, S1, S2).** Overall, the identity layer and the whole deployment pipeline (to staging) are in place; trainers can build draft exams; payments, taking exams and certificates do not exist yet.

**What exists today:** a private-by-default API with login and roles, a web app with sign-up/sign-in/profile/admin user list, a Postgres database with migrations, AWS staging (VPC, EC2, RDS, S3, CloudFront, ECR, SES, IAM deploy role), HTTPS on both hostnames, and 57 passing automated tests.

**Needs your action (cannot be done from code):**

1. Fix GitHub billing (Settings, Billing & plans) so Actions can run CI and deploys. Until then, deploys are run manually from a developer machine.
2. Wait for / follow up on the SES production-access request (status PENDING). Until approved, only verified addresses receive emails.
3. Complete Razorpay business KYC and create TEST keys (needed for Sprint 3).
4. Create the first admin account (see `README.md`, "First admin").
5. Optional: choose an email for AWS budget alerts (currently off).

---

## 0. Decisions already made

| Topic                   | Decision                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend hosting         | **AWS first.** API, database, storage, email and code runner on AWS. Firebase Spark is optional (e.g. push notifications later); it can't run server code.                                                              |
| Existing Exam Hall code | **Rebuild and reuse features.** New secure, typed codebase. Port the question parser, the anti-cheat logic, the exam/grading flows and the UI ideas. Migrate real data.                                                 |
| Certificate approval    | The **NandiVex admin** approves certificates before they are released.                                                                                                                                                  |
| Coding questions        | **Auto-graded** against hidden test cases in a sandbox (self-hosted Judge0) at launch.                                                                                                                                  |
| Payments                | Razorpay (Orders, Checkout, Webhooks). All money lands in NandiVex's account; **the examiner's 50% is paid out manually** by NandiVex (no Razorpay Route).                                                              |
| Domain                  | **`assessiq.nandivex.in`** (a subdomain of the company domain `nandivex.in`, DNS at GoDaddy). Hostnames: `app.` / `api.` for production, `app-staging.` / `api-staging.` for staging, all under `assessiq.nandivex.in`. |

### Deviations from the original plan (decided while building)

| Area                 | Plan said                         | What was built                                                                   | Why                                       |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| Package manager      | pnpm                              | npm workspaces                                                                   | pnpm was not installed; npm works fine    |
| Terraform locking    | DynamoDB table                    | S3 lock file (`use_lockfile`)                                                    | Simpler, no extra service                 |
| Web hosting          | Next.js static on S3 + CloudFront | Same, with `output: 'export'`, `trailingSlash` and a CloudFront rewrite function | Pretty URLs on a static export            |
| Prisma               | latest                            | Prisma 6                                                                         | Prisma 7/8 has breaking config changes    |
| Password hashing     | argon2id                          | `@node-rs/argon2` (argon2id)                                                     | Prebuilt binaries work on ARM Alpine      |
| Access token storage | not specified                     | In memory only; refresh token in an httpOnly cookie                              | Not readable by page scripts              |
| IDs                  | not specified                     | UUIDs (Postgres `uuid`)                                                          | Safer than sequential ids                 |
| CI/CD                | GitHub Actions deploy             | Workflows written; manual deploy used for now                                    | GitHub account billing blocks Actions     |
| ESLint, commit hooks | in Sprint 0                       | Not yet; Prettier only                                                           | Deferred                                  |
| Budget alerts        | $20/$50/$80                       | Off                                                                              | You skipped them; Terraform option exists |

---

## 1. Product scope

### 1.1 Roles

| Role                   | Who            | Can                                                                                                                                 |
| ---------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Student**            | Candidate      | Join an exam by code, pay ₹149 (or use a sponsored seat), take the exam, see results, use the practice set, receive the certificate |
| **Examiner / Trainer** | Creator        | Pay ₹199 per exam, build exams, upload a logo, sponsor seats, grade subjective answers, finalise results, view earnings             |
| **NandiVex Admin**     | Platform staff | Approve certificates, manage users/exams, payments, refunds, payouts, platform settings, audit logs                                 |
| _(Phase 5)_ Org Admin  | Institute      | Manage several trainers under one organisation                                                                                      |

### 1.2 Business rules

| #    | Rule                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR-1 | Creating an exam costs **₹199**. The exam stays in `DRAFT` until paid and can't be published without payment.                                                                                                 |
| BR-2 | Joining an exam costs **₹149 per student**, paid by the student **or** by the trainer on their behalf (sponsored seats).                                                                                      |
| BR-3 | For student-paid fees, **50% goes to the examiner and 50% to NandiVex**, tracked in a ledger. NandiVex **pays the examiner's 50% manually** (UPI/bank transfer) on a schedule; it is not split automatically. |
| BR-4 | Every exam has a unique **exam code**. Students join only with that code.                                                                                                                                     |
| BR-5 | When creating an exam, the trainer uploads a **custom logo**. Every certificate shows that logo **and** the NandiVex logo.                                                                                    |
| BR-6 | After a student takes the exam, a **practice set with the same questions** unlocks **only for that student**.                                                                                                 |
| BR-7 | Certificates are generated after results are final. They go to a **NandiVex admin approval queue** and are **emailed only after approval**, to the student's registered email.                                |
| BR-8 | Question types: **single-choice MCQ, multiple-choice MCQ, subjective, coding**.                                                                                                                               |

### 1.3 Exam lifecycle

```mermaid
stateDiagram-v2
  [*] --> DRAFT: trainer creates
  DRAFT --> PAYMENT_PENDING: submit for publish
  PAYMENT_PENDING --> PUBLISHED: ₹199 captured (webhook)
  PUBLISHED --> LIVE: start time reached
  LIVE --> CLOSED: end time reached / trainer closes
  CLOSED --> GRADING: subjective/coding review pending
  GRADING --> RESULTS_FINAL: trainer finalises
  CLOSED --> RESULTS_FINAL: all auto-graded
  RESULTS_FINAL --> CERT_PENDING_APPROVAL: certificates generated
  CERT_PENDING_APPROVAL --> CERT_RELEASED: NandiVex admin approves → emails sent
  CERT_PENDING_APPROVAL --> RESULTS_FINAL: admin rejects (with reason)
```

### 1.4 Student attempt lifecycle

`ENROLLED (paid / sponsored)` → `IN_PROGRESS` (server records start time) → `SUBMITTED` / `AUTO_SUBMITTED` (time up or 3 strikes) → `GRADED` → `RESULT_PUBLISHED` → _practice set unlocked_ → `CERTIFICATE_ISSUED`

---

## 2. Target architecture

### 2.1 High level

```mermaid
flowchart LR
  subgraph Client
    W[Next.js Web App / PWA<br/>Student · Examiner · Admin]
  end
  subgraph AWS
    CF[CloudFront + S3<br/>static web assets]
    API[NestJS API<br/>REST + WebSocket]
    WK[Worker<br/>BullMQ jobs]
    RD[(Redis<br/>queues · cache · sessions)]
    PG[(PostgreSQL<br/>RDS)]
    S3[(S3<br/>logos · certificates · uploads)]
    J0[Judge0<br/>code sandbox]
    SES[Amazon SES<br/>email]
    CW[CloudWatch<br/>logs · alarms]
  end
  RZ[Razorpay<br/>Orders · Webhooks]
  DNS[GoDaddy DNS]

  DNS --> CF
  DNS --> API
  W --> CF
  W -->|HTTPS / JWT| API
  W -->|Checkout| RZ
  RZ -->|signed webhook| API
  API --> PG
  API --> RD
  API --> S3
  API -->|enqueue| RD
  RD --> WK
  WK --> J0
  WK --> PG
  WK --> S3
  WK --> SES
  API --> CW
  WK --> CW
```

### 2.2 Tech stack

| Layer            | Choice                                                                                                                   | Why                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Frontend         | **Next.js (React, TypeScript)**, Tailwind, shadcn/ui, Monaco editor, PWA                                                 | Typed, SEO for public pages (certificate verification), a good code editor  |
| API              | **NestJS (TypeScript)**, modular monolith                                                                                | Clear module boundaries, guards for RBAC, easy to split into services later |
| ORM / validation | Prisma + Zod (shared schemas)                                                                                            | Typed DB access; the same validation on client and server                   |
| Database         | **PostgreSQL** on Amazon RDS (`db.t4g.micro` to start)                                                                   | Relational data (payments, ledger, grades) needs transactions               |
| Queue / cache    | Redis + **BullMQ**                                                                                                       | Code grading, PDF generation, email                                         |
| Code execution   | **Judge0 CE** (self-hosted on EC2, Docker)                                                                               | Isolated sandbox, 60+ languages, time/memory limits                         |
| Files            | **S3** (private) + CloudFront signed URLs                                                                                | Logos, certificates, question images                                        |
| PDF              | HTML template → PDF (Playwright/Chromium in the worker)                                                                  | Pixel-accurate certificates with two logos and a QR code                    |
| Email            | **Amazon SES** (DKIM/SPF/DMARC on the domain)                                                                            | Cheap (~$0.10 per 1,000 emails), supports attachments                       |
| Auth             | In-house: argon2id passwords, short-lived JWT access + rotating refresh tokens (httpOnly cookie), email OTP verification | Full control; no per-user cost                                              |
| Payments         | Razorpay Orders API + Checkout + Webhooks                                                                                | Simple collection into one account; payouts handled manually by NandiVex    |
| IaC / CI         | Terraform (or AWS CDK) + GitHub Actions                                                                                  | Repeatable environments                                                     |
| Observability    | CloudWatch logs and alarms, Sentry (free tier)                                                                           | Error tracking                                                              |

### 2.3 Deployment (cost-aware for the $100 credit)

**Stage A: Launch (fits the credit for roughly 2–4 months):**

- **EC2 `t4g.medium`** running Docker Compose: `api`, `worker`, `redis`, `judge0` (server + workers), `caddy` (TLS via Let's Encrypt).
- **RDS PostgreSQL `db.t4g.micro`**, 20 GB, automated backups 7 days.
- **S3 + CloudFront** for the web app and files.
- **SES** for email.
- **Two environments:** `staging` (smaller EC2, can be stopped at night) and `production`.

**Stage B: Scale (when revenue justifies it):** API and worker on ECS Fargate behind an ALB, Judge0 on its own EC2 Auto Scaling group, RDS Multi-AZ, ElastiCache Redis, WAF.

> Indicative Stage A cost is **~$40–60/month** (EC2 ~$25, RDS ~$15, S3/CloudFront/SES a few dollars). These are estimates; check them in the AWS Pricing Calculator for your region (ap-south-1, Mumbai), and set an **AWS Budget alert at $20 / $50 / $80**.

### 2.4 Repository layout (monorepo)

```
assessiq/
├── apps/
│   ├── web/          # Next.js: student, examiner and admin areas
│   ├── api/          # NestJS: REST + WebSocket
│   └── worker/       # BullMQ consumers: grading, PDF, email
├── packages/
│   ├── shared/       # Zod schemas, types, enums, constants (prices, limits)
│   ├── ui/           # Shared React components
│   └── question-parser/   # Ported from Exam Hall parseQuestionsTxt (+ tests)
├── infra/            # Terraform, docker-compose, Caddyfile
├── legacy/exam-hall/ # Old code, read-only, for reference and data migration
└── .github/workflows/
```

### 2.5 API modules (NestJS)

`auth` · `users` · `exams` · `questions` · `attempts` · `proctoring` · `grading` · `code-runner` · `results` · `practice` · `payments` · `ledger` · `payouts` · `certificates` · `notifications` · `admin` · `audit` · `files`

### 2.6 Data model (core tables)

| Table               | Key columns                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`             | id, role (`STUDENT`/`EXAMINER`/`ADMIN`), name, email (unique, verified_at), phone, password_hash, status                                                                       |
| `examiner_profiles` | user_id, org_name, logo_s3_key, payout_method (`UPI`/`BANK`), upi_id, bank_account_name, bank_account_no_enc, ifsc, payout_details_verified_at                                 |
| `exams`             | id, examiner_id, title, description, code (unique), status, start_at, end_at, duration_min, pass_percent, shuffle_questions, shuffle_options, logo_s3_key, creation_payment_id |
| `questions`         | id, exam_id, type (`SINGLE`/`MULTI`/`SUBJECTIVE`/`CODING`), body, marks, negative_marks, order, explanation                                                                    |
| `question_options`  | id, question_id, text, is_correct                                                                                                                                              |
| `coding_specs`      | question_id, allowed_languages[], starter_code json, time_limit_ms, memory_kb                                                                                                  |
| `coding_test_cases` | id, question_id, input, expected_output, is_hidden, weight                                                                                                                     |
| `enrollments`       | id, exam_id, student_id, source (`SELF_PAID`/`SPONSORED`), payment_id, seat_id                                                                                                 |
| `sponsored_seats`   | id, exam_id, purchased_by, payment_id, assigned_email, redeem_token, redeemed_at                                                                                               |
| `attempts`          | id, enrollment_id, started_at, deadline_at, submitted_at, status, score, max_score, question_order json, strike_count                                                          |
| `answers`           | id, attempt_id, question_id, selected_option_ids[], text, code, language, awarded_marks, graded_by, feedback                                                                   |
| `code_submissions`  | id, answer_id, judge0_token, status, passed, total, stdout/err (truncated)                                                                                                     |
| `proctor_events`    | id, attempt_id, type, at, meta                                                                                                                                                 |
| `practice_access`   | student_id, exam_id, unlocked_at                                                                                                                                               |
| `practice_attempts` | id, student_id, exam_id, score, created_at                                                                                                                                     |
| `payments`          | id, razorpay_order_id, razorpay_payment_id, purpose (`EXAM_CREATION`/`EXAM_JOIN`/`SEAT_BUNDLE`), payer_id, exam_id, amount_paise, status, raw webhook                          |
| `ledger_entries`    | id, payment_id, account (`PLATFORM`/`EXAMINER:<id>`), amount_paise, type (`CREDIT`/`FEE`/`REFUND`/`PAYOUT`)                                                                    |
| `payouts`           | id, examiner_id, amount_paise, method, bank_ref/UTR, period_from, period_to, status (`REQUESTED`/`PAID`/`FAILED`), paid_by (admin), paid_at, note                              |
| `certificates`      | id, attempt_id, serial_no, status (`GENERATED`/`APPROVED`/`REJECTED`/`EMAILED`), pdf_s3_key, approved_by, approved_at, emailed_at, verify_hash                                 |
| `audit_logs`        | actor_id, action, entity, entity_id, before/after, ip, at                                                                                                                      |

### 2.7 Key flows

**A. Exam creation payment (₹199)**

1. Trainer clicks Publish. The API creates a Razorpay Order (`purpose=EXAM_CREATION`, `exam_id` in notes).
2. Checkout runs on the client. On success the client sends `payment_id` + signature, and the API verifies the signature.
3. The **webhook `payment.captured` is the source of truth**: mark paid, generate the exam code, move the exam to `PUBLISHED`. Handlers are idempotent on `razorpay_payment_id`.

**B. Student join (₹149) with manual 50/50 payout**

1. Student enters the code. The API shows exam info (no questions) and creates an Order.
2. Payment goes to NandiVex's Razorpay account (no split at payment time).
3. On capture (webhook): enrollment created, ledger written: PLATFORM +50% (less Razorpay fee, see Q2), **EXAMINER balance +50% (status `ACCRUED`)**.
4. Examiner share becomes `PAYABLE` once the exam is `RESULTS_FINAL` (refund window closed). Examiner sees "Accrued / Payable / Paid" balances on their dashboard.
5. **Manual payout:** admin opens the payout screen, sees every examiner whose payable balance is at or above the minimum (default ₹500), pays by UPI/bank, then records the UTR and marks the payout `PAID`. The ledger entry is written, the examiner is notified by email and gets a payout statement (CSV/PDF). The examiner can also click "Request payout".

**C. Sponsored seats (trainer pays for students)**

- Trainer buys N seats (₹149 × N) in one Order, then assigns them by email list / CSV or shares redeem links. A student who redeems is enrolled without paying.
- Payout split for sponsored seats: see **Open question Q1**.

**D. Taking the exam (server-authoritative)**

- `POST /attempts/start` records `started_at` and `deadline_at = min(start + duration, exam.end_at)`, and stores a per-student shuffled question/option order.
- Questions are delivered **without correct answers or hidden test cases**.
- Autosave every answer (debounced) plus offline queue retry. Submissions after `deadline_at + grace` are rejected.
- Anti-cheat (ported from Exam Hall): fullscreen, tab/blur detection, copy/paste and shortcut blocking, 3-strike auto-submit. **Every event is also sent to the server** (`proctor_events`), and the server decides auto-submit.

**E. Grading**

- Single MCQ: correct → +marks, wrong → −negative, blank → 0.
- Multi MCQ: configurable per exam: **all-or-nothing** (default) or **partial** (+marks × correct/total if no wrong choices).
- Coding: worker sends the code to Judge0 per test case. Score = Σ weights of passed cases. Students see sample-case results during the exam ("Run") and hidden results only after publish.
- Subjective: examiner grading screen with a model answer and rubric; marks capped at max.
- Examiner **finalises results**, which triggers the practice unlock and certificate generation.

**F. Practice set**

- Unlocks for a student **only if they have a submitted attempt**, and **only after the exam is `CLOSED`**, so that answers can't leak to students still taking it.
- Same questions in practice mode: unlimited attempts, instant feedback, explanations, coding re-runs. No proctoring, no certificate.

**G. Certificates**

1. On `RESULTS_FINAL`, the worker generates a PDF per student: student name, exam title, score/grade, date, **trainer logo + NandiVex logo**, a unique serial, and a QR code linking to `https://<domain>/verify/<serial>`.
2. The certificates go to the **NandiVex admin approval queue** (bulk approve per exam, preview, reject with reason).
3. On approval, the worker emails each student through SES with the PDF attached (or a signed download link). Bounces and complaints are tracked through SNS.
4. A public **verification page** shows whether a certificate is valid.

---

## 3. Security, compliance and quality

- **OWASP top 10**: input validation (Zod), parameterised queries (Prisma), output escaping (React), CSP headers, rate limiting (login, OTP, join-by-code), brute-force lockout.
- **Secrets** in AWS SSM Parameter Store, never in code. Razorpay webhook secret verification on every webhook.
- **RBAC + ownership checks** on every route (examiners only see their own exams; students only their own attempts).
- **Answer protection**: correct options, hidden tests and model answers never leave the server before publish.
- **Audit log** for payments, grading changes, certificate approvals and admin actions.
- **India DPDP Act 2023**: privacy policy, consent at sign-up, data export/delete requests, minimal data collection. Webcam data only with explicit consent (Phase 5).
- **Payments**: Terms, Refund & Cancellation policy, and Contact pages (Razorpay requires them for live mode). GST invoices (see **Q2**).
- **Testing**: unit tests (grading, parser, ledger and payout math), integration tests (API + DB), Playwright E2E for the main journeys, k6 load test (target: **500 concurrent students** in one exam on Stage A).
- **Backups**: RDS daily snapshots (7 days) plus S3 versioning on certificates.

---

## 4. Delivery plan: phases and sprints

**Assumptions:** 2-week sprints. A team of **2 full-stack developers + 1 part-time designer/QA**, with a NandiVex product owner. **13 sprints, about 26 weeks (~6 months)** to public launch. A larger team can run Phases 2 and 3 in parallel.

Each sprint ends with a demo on `staging` and a short retro. "Done" means code reviewed, tests passing, deployed to staging, and acceptance criteria met.

### Phase 0: Foundation (Sprint 0, weeks 1–2): ✅ Done, with open items

**Goal:** everything needed to build and ship safely, plus the long-lead external approvals.

| Status | Sprint 0 item                                                                | Detail                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅     | Git repo + monorepo scaffold (web / api / worker / shared / question-parser) | Repo is public at `devxjitin/assessiq`; Prettier enforced                                                                                             |
| 🟡     | Lint, commit hooks                                                           | Prettier done; **ESLint and commit hooks not added**                                                                                                  |
| 🟡     | AWS account hardening                                                        | IAM admin user in use, ap-south-1 region used; root MFA not verified by us; **budget alerts skipped by choice**                                       |
| ✅     | Terraform: VPC, EC2, RDS, S3, CloudFront, ECR, SES, IAM                      | **Staging applied** and running. Production config written, **not applied**                                                                           |
| ✅     | Local dev stack                                                              | Docker Compose Postgres + Redis, verified                                                                                                             |
| ✅     | Docker images (API, worker, ARM64) and server deploy script                  | Built, pushed to ECR, deployed and health-checked on the server                                                                                       |
| 🟡     | GitHub Actions CI → staging deploy                                           | `ci.yml` and `deploy-staging.yml` written, OIDC role and environment variables created. **⛔ Blocked: GitHub account billing.** Deploys done manually |
| ✅     | DNS at GoDaddy (staging)                                                     | `app-staging`, `api-staging`, certificate validation and 3 DKIM records all verified. `verify.` subdomain not needed yet                              |
| ✅     | SES domain verification                                                      | `assessiq.nandivex.in` verified (DKIM success). SPF/DMARC not configured yet                                                                          |
| ✅     | SES production-access request                                                | Submitted; **status PENDING** with AWS                                                                                                                |
| ⬜     | Razorpay business KYC and test keys                                          | **Your action**                                                                                                                                       |
| ⬜     | GST registration check                                                       | **Your action**                                                                                                                                       |
| ⬜     | Design system + wireframes                                                   | Not done; UI so far is a simple built-in style                                                                                                        |
| ✅     | Legacy audit                                                                 | `../PROJECT_OVERVIEW.md`; question parser ported with tests (125-question sample passes)                                                              |

**Exit criteria:** "Hello world" web + API deployed on staging over HTTPS ✅ (met). Razorpay test keys working ⬜ (pending your Razorpay account).

### Phase 1: Core assessment MVP (Sprints 1–5, weeks 3–12)

**Goal:** a trainer can pay ₹199 and publish an exam; a student can pay ₹149, take it and see results (MCQ + subjective).

| Sprint                            | Goal                | Scope                                                                                                                                                                                                                                 | Acceptance criteria                                                                                           |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **S1: Identity** ✅               | Secure accounts     | Sign-up/login for Student and Examiner, email OTP verification (SES), JWT + refresh, password reset, RBAC guards, profile pages, admin seed user, audit log base                                                                      | Passwords hashed (argon2id); unverified emails can't join or create exams; role guards covered by tests       |
| **S2: Exam builder** ✅           | Build exams         | Exam CRUD (draft), settings (duration, window, pass %, shuffle, negative marks), **single + multi MCQ** and **subjective** editors, **logo upload** to S3, bulk import (ported parser, extended for multi-select), preview as student | Trainer builds a 100-question exam in under 10 minutes via import; logo stored privately                      |
| **S3: Creation payments** ⬜ next | ₹199 to publish     | Razorpay Orders + Checkout, signature verification, **webhook handler** (idempotent), payment records, invoice/receipt email, exam code generation (crypto-random, e.g. `NVX-7K3P9Q`), share link/QR/WhatsApp                         | Exam can't be published without a captured payment; a duplicate webhook doesn't double-process                |
| **S4: Join & take exam** ⬜       | Student exam engine | Join by code → ₹149 payment → enrollment; exam lobby; **server-timed attempt**, per-student shuffle, autosave, navigator/flagging, submit/auto-submit; ported anti-cheat with server-side event logging and strike decision           | Answers survive a page refresh/network drop; late submissions rejected; the API never returns correct answers |
| **S5: Grading & results** ⬜      | Results             | Auto-grade single/multi MCQ (all-or-nothing/partial), subjective grading screen with rubric and feedback, finalise results, student result page and scorecard, examiner dashboard (attempts, scores, violations), CSV export          | Grading math covered by unit tests; results hidden until finalised                                            |

#### Sprint 2 completion report ✅ (done and live on staging)

| Scope item                                                | Status | Where / how                                                                                                              |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Exam create, edit, delete (draft only)                    | ✅     | `/exams` API; web `/exams/`, `/exams/new/`, `/exams/edit/?id=`. Non-draft exams are locked (409)                         |
| Settings: duration, window, pass %, shuffle, max students | ✅     | Window (opens/closes) is optional while drafting and becomes required at publish (Sprint 3)                              |
| Negative marking                                          | ✅     | Set **per question** (default 0), not per exam, so mixed papers work; cannot exceed the question marks                   |
| Single-answer, multiple-answer and subjective questions   | ✅     | Validated with shared zod rules; reorder and delete renumber safely; limit 300 questions                                 |
| Bulk import (parser extended for multi-select)            | ✅     | Paste text, **check** (preview) then import; default marks and negative marks apply                                      |
| Logo upload, stored privately                             | ✅     | PNG/JPEG up to 512 KB, type sniffed from content (SVG refused); private S3 key; served only to the owner through the API |
| Preview as student                                        | ✅     | Never includes correct answers, explanations or rubrics (tested)                                                         |
| Ownership                                                 | ✅     | A trainer cannot read or change another trainer's exam (404)                                                             |
| Tests                                                     | ✅     | **19 new API tests**; 57 in the whole repo                                                                               |
| Deployed                                                  | ✅     | Web, API and migration on staging. Dockerfile updated to include the question-parser package                             |

**Acceptance criteria:** bulk import works for large papers (300-question limit tested; the 125-question CEH sample parses). The "under 10 minutes" timing was not measured with a real trainer. Logo is stored privately ✅.

**Known gaps after Sprint 2:**

- Coding questions are not available yet (Sprint 6). Subjective answers are marked by hand (Sprint 5).
- Not smoke-tested on staging with a real trainer account yet (needs an email that SES can deliver to while in sandbox).
- No automated browser UI tests; the pages were type-checked and built, not clicked through.
- No question images or rich text yet; questions are plain text.

#### Sprint 1 completion report ✅ (done and live on staging)

| Scope item                                                   | Status | Where / how                                                                                                            |
| ------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Sign-up for Student and Trainer (Admin cannot self-register) | ✅     | `POST /auth/register`; web `/register/`                                                                                |
| Email verification by 6-digit code (SES)                     | ✅     | Codes hashed, expire in 10 min, 5 attempts, 1 resend per minute                                                        |
| Login, JWT access token (15 min) + rotating refresh token    | ✅     | Refresh cookie is httpOnly; reuse of an old token revokes the whole session family                                     |
| Logout                                                       | ✅     | Revokes the refresh token                                                                                              |
| Password reset (emailed code) and change password            | ✅     | Both sign the user out on all other devices                                                                            |
| RBAC guards                                                  | ✅     | Global JWT guard + `@Roles()`; routes private unless `@Public()`; account re-checked on every request                  |
| Profile page and API                                         | ✅     | Name, phone, trainer organisation; role and email cannot be changed here                                               |
| Admin: user list and suspend/reactivate                      | ✅     | `GET /admin/users`, `PATCH /admin/users/:id/status`; suspension takes effect immediately                               |
| Admin seed script                                            | ✅     | `npm run seed:admin` (no admin has been created yet; needs your email/password)                                        |
| Audit log base                                               | ✅     | Registration, verification, login, failures, lockouts, reuse detection, password changes, profile edits, admin actions |
| Hardening beyond the plan                                    | ✅     | Account lockout after 5 failures (15 min), rate limits on auth routes, helmet security headers, no account enumeration |
| Database                                                     | ✅     | Prisma schema + migration; applied to staging RDS during deploy                                                        |
| Tests                                                        | ✅     | **28 API tests** on a real Postgres database (38 in the whole repo)                                                    |
| Deployed                                                     | ✅     | Web + API on staging; migrations run automatically by the deploy script                                                |

**Acceptance criteria:** passwords hashed with argon2id ✅ (tested). Unverified emails cannot sign in, so they cannot join or create exams ✅ (the exam features do not exist yet; the guard is in place). Role guards covered by tests ✅.

**Known gaps after Sprint 1:**

- Real users cannot receive emails until AWS approves SES production access (sandbox: verified addresses only).
- No admin account exists yet.
- The staging database holds one smoke-test user (`success@simulator.amazonses.com`).
- The dashboard cards for exams, results and earnings are placeholders for later sprints.
- No automated browser (end-to-end UI) tests yet; the web pages were checked manually.
- CI/CD on GitHub is blocked by billing (deploys are manual).

**Phase 1 exit (internal alpha):** run one real exam with NandiVex staff as students.

### Phase 2: Coding questions & exam integrity (Sprints 6–7, weeks 13–16)

**Goal:** auto-graded coding questions and stronger anti-cheating.

| Sprint                      | Goal       | Scope                                                                                                                                                                                                                                                                       | Acceptance criteria                                                                                                                     |
| --------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **S6: Coding engine**       | Coding Qs  | Judge0 on EC2 (Docker, network disabled, CPU/memory limits); coding question editor (statement, languages, starter code, sample + hidden tests, weights, limits); Monaco editor for students with "Run on samples"; worker grading via queue; per-test results              | Python, C, C++, Java and JavaScript work; an infinite loop/fork bomb is killed within limits; 50 concurrent runs queue without crashing |
| **S7: Integrity hardening** | Fair exams | Question/option shuffle per student, question pools (random N of M), IP/device fingerprint per attempt, one active session per attempt, violation timeline for examiners, rate limits on join codes, plagiarism check on coding answers (token similarity between students) | A second device can't continue the same attempt; the examiner sees a per-student violation report                                       |

### Phase 3: Monetisation, practice & certificates (Sprints 8–10, weeks 17–22)

**Goal:** money flows correctly, practice sets unlock, certificates are approved and emailed.

| Sprint                                       | Goal                            | Scope                                                                                                                                                                                                                                                                                                                                                         | Acceptance criteria                                                                                                                                                            |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S8: Ledger, manual payouts & sponsorship** | Revenue tracking + trainer pays | **Double-entry ledger**, examiner earnings dashboard (accrued/payable/paid), examiner payout details (UPI/bank, encrypted), **admin payout screen** (payable list, minimum threshold, mark paid with UTR, payout statements), **sponsored seats** (bulk buy, CSV assign, redeem links), refunds flow (admin-initiated; reverses the examiner's accrued share) | For each ₹149 payment the ledger balances to the paisa; a refund reverses both shares; paying out creates a ledger entry and statement; sponsored students join without paying |
| **S9: Certificates**                         | Approved certificates by email  | Certificate template designer (layout, two logos, signature line), PDF generation in worker, serial + QR, **NandiVex admin approval queue** (preview, bulk approve, reject with reason), SES email with attachment, bounce handling, public `/verify/<serial>` page, re-send option                                                                           | No certificate is emailed before admin approval; the verification page shows the correct holder and exam                                                                       |
| **S10: Practice sets**                       | Post-exam practice              | Practice access unlock (attempted students only, after exam closes), practice mode UI with explanations and instant feedback, coding re-runs, practice history; student dashboard showing exams, results, practice and certificates                                                                                                                           | A student who didn't attempt can't open practice (API returns 403); practice never affects official scores                                                                     |

### Phase 4: Admin console, migration & launch (Sprints 11–12, weeks 23–26)

**Goal:** operate the business and go live.

| Sprint                      | Goal               | Scope                                                                                                                                                                                                                                                                                                                                                                             | Acceptance criteria                                                                                                |
| --------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **S11: Admin & migration**  | Run the platform   | NandiVex admin console: users (suspend/verify), exams, payments and refunds, payout reports and a monthly **owed-to-examiners** summary, certificate queue, platform settings (prices, split %, limits), audit log viewer, revenue analytics; **migrate Exam Hall data** (users must reset passwords, since old ones were plaintext); notifications (exam reminders, results out) | Admin can answer "how much did we earn and owe this month" from the console; migrated users can log in after reset |
| **S12: Hardening & launch** | Production go-live | Security review (OWASP checklist, dependency scan, pen-test of auth/payments), k6 load test (500 concurrent), backup/restore drill, monitoring + alarms, legal pages (Terms, Privacy, Refund, Contact), **Razorpay live mode**, production deploy, UAT with 2–3 pilot trainers, runbook                                                                                           | Pilot exams complete with zero payment mismatches; P95 API latency < 500 ms at load; go/no-go sign-off by NandiVex |

**Launch milestone:** public release at about week 26.

### Phase 5: Growth (post-launch backlog, prioritise after launch)

- Organisation accounts (an institute with many trainers, shared billing)
- Webcam proctoring with periodic snapshots to S3 and AI flagging (consent required)
- Question bank library and reuse across exams; AI-assisted question generation
- Advanced analytics (item difficulty, discrimination, cohort comparison)
- Certificate sharing to LinkedIn; custom certificate templates per trainer
- Mobile app (React Native / Capacitor) and a Hindi/regional language UI
- Discount coupons, subscription plans for frequent trainers
- Stage B infrastructure (ECS, Multi-AZ, WAF)

### Timeline summary

```
Weeks:  1-2 | 3-12              | 13-16        | 17-22                  | 23-26        | 27+
Phase:  P0  | P1 Core MVP       | P2 Coding    | P3 Money/Cert/Practice | P4 Launch    | P5 Growth
Sprint: S0  | S1 S2 S3 S4 S5    | S6 S7        | S8 S9 S10              | S11 S12      | backlog
```

---

## 5. What we reuse from Exam Hall

| Exam Hall piece                                                                                                                                              | Reuse in AssessIQ                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `parseQuestionsTxt` (bulk import)                                                                                                                            | Ported to `packages/question-parser`, extended for multi-select, with real tests (from `scratch/`) |
| Anti-cheat listeners (fullscreen, blur, keys, strikes, alert sound)                                                                                          | Ported to a React hook; events also reported to the server                                         |
| MCQ grading with negative marks                                                                                                                              | Moved server-side, extended for multi-select partial scoring                                       |
| Lab-key join flow, WhatsApp/QR sharing                                                                                                                       | Kept as exam codes with crypto-random generation                                                   |
| Result gating (hidden until published)                                                                                                                       | Kept, now enforced by the API and database permissions                                             |
| Evaluator / scorecard UX                                                                                                                                     | Used as the basis for wireframes                                                                   |
| **Dropped:** plaintext passwords, open Supabase RLS, `localStorage` admin, manual UPI/UTR verification, client-side-only grading, three copies of the client |                                                                                                    |

---

## 6. Risks

| Risk                                       | Impact                            | Mitigation                                                                                                                                                                                                     |
| ------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual payouts are late, wrong or disputed | Trainers lose trust               | Clear Accrued/Payable/Paid dashboard, fixed payout schedule (e.g. 5th of each month), UTR recorded for every payout, payout statements, admin checklist; automate with RazorpayX Payouts later if volume grows |
| SES stays in sandbox                       | Certificates/OTP can't be emailed | Apply in Sprint 0; fallback SMTP (e.g. Zoho/Brevo free tier)                                                                                                                                                   |
| $100 credit runs out                       | Infra stops                       | Budget alerts, stop staging at night, plan for paid infra from revenue by month 3                                                                                                                              |
| Judge0 abuse / overload                    | Slow or unsafe grading            | Isolated EC2, no network, queue with concurrency limits, per-user rate limits                                                                                                                                  |
| Answer leakage via practice sets           | Unfair exams                      | Unlock only after the exam closes; per-student shuffles                                                                                                                                                        |
| Client-side proctoring is bypassable       | Cheating                          | Treat as deterrence; server-side timing, session locks, plagiarism checks, violation reports                                                                                                                   |
| Scope creep                                | Late launch                       | Phase 5 backlog; changes enter only at sprint planning                                                                                                                                                         |

---

## 7. Open questions

**Status:** the owner chose to **keep all defaults** (Q1 to Q8). Q7 is resolved: the product is AssessIQ and the domain is `assessiq.nandivex.in`. Q2 still needs an accountant check (GST registration) before go-live. To change a default, edit the table below.

| #      | Question                                                                                                                                                          | Default assumed                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Q1** | When the **trainer pays** for students (sponsored seats), does the 50/50 split still apply? (That would credit ₹74.50 per seat to the trainer's payable balance.) | **No split on sponsored seats**; the full ₹149 goes to NandiVex (✅ defaults kept by owner)       |
| **Q2** | Are ₹199 / ₹149 **GST-inclusive**? Is NandiVex GST-registered? Who bears the **Razorpay fee** (~2%)?                                                              | GST-inclusive; Razorpay fee comes out of NandiVex's share; split is on the gross amount           |
| **Q3** | Certificate for **every student** or only those above the pass mark?                                                                                              | Two templates: _Certificate of Achievement_ (≥ pass %) and _Certificate of Participation_ (below) |
| **Q4** | Refund policy (e.g. exam cancelled by trainer, student couldn't attend)?                                                                                          | Full refund only if the trainer cancels before the exam starts                                    |
| **Q5** | Are there **limits** per exam (questions, students, duration)?                                                                                                    | 300 questions, 1,000 students, 6 hours max                                                        |
| **Q6** | Should practice sets ever expire?                                                                                                                                 | Available for 90 days after the exam closes                                                       |
| **Q7** | Is the product name **AssessIQ** final, and which GoDaddy domain will be used?                                                                                    | `assessiq` subdomain on the NandiVex domain. **Resolved: `assessiq.nandivex.in`**                 |
| **Q8** | Team size and target launch date?                                                                                                                                 | 2 developers + part-time designer/QA; launch in ~6 months                                         |

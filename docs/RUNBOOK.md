# Parakh operations runbook

For the person on call (today: one developer). Short, concrete, and honest about what has not been tried yet. Items marked **NOT YET DRILLED** were written from the code and Terraform but never run end to end; do them once on staging before you depend on them.

## 1. Where things live

| Thing                    | Where                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (static site)        | S3 bucket behind CloudFront. Built and uploaded by the `web` job of the **Deploy staging** workflow.                                                                                                     |
| API and worker           | Docker containers on one EC2 host, started by `docker compose` (`infra/deploy/docker-compose.yml`: `caddy`, `api`, `worker`, `redis`). App files are in `/opt/assessiq` on the host.                     |
| Database                 | RDS Postgres 16, single instance, **not Multi-AZ**, not publicly reachable. Automated backups, 7 days by default (`db_backup_retention_days`), nightly window 01:30–02:30 IST.                           |
| App settings and secrets | SSM Parameter Store, one parameter per setting: `/assessiq/<environment>/<NAME>` (for example `/assessiq/staging/JWT_ACCESS_SECRET`). `deploy.sh` copies them into `/opt/assessiq/.env` on every deploy. |
| Database password        | AWS Secrets Manager (RDS-managed). `deploy.sh` reads it; never put it in SSM.                                                                                                                            |
| Images                   | ECR, tagged with the git commit SHA.                                                                                                                                                                     |
| Mail                     | Amazon SES. Bounce notices arrive at a secret URL guarded by `SES_EVENTS_KEY`.                                                                                                                           |
| Payments                 | Razorpay (production). Staging uses the fake provider, allowed only because `/assessiq/staging/ALLOW_FAKE_PAYMENTS=true`. **Never set that in production.**                                              |
| Code runner              | Judge0 host (`infra/terraform/judge0.tf`), optional.                                                                                                                                                     |

Region is `ap-south-1`. Terraform state is configured in `infra/terraform/backend.hcl`; per-environment values are in `infra/terraform/envs/`.

## 2. Is it up? (first five minutes of any incident)

1. `GET <api-host>/health` → `{"status":"ok","database":"ok"}`. It answers **503** with `"database":"unreachable"` when the database cannot be reached, so a health check or alarm can use the status code.
2. Open an SSM session to the app host (EC2 console → Connect → Session Manager), then:
   ```bash
   cd /opt/assessiq
   docker compose --env-file .deploy.env ps
   docker compose --env-file .deploy.env logs --tail=100 api
   ```
3. In production the API writes **one JSON line per request** (`reqId`, `method`, `path`, `status`, `ms`, `userId`) and one `unhandled error` line (with stack) for every unexpected 500. Query strings, bodies, headers and IP addresses are never logged. Every response carries an `x-request-id` header: ask the person who hit the error for it and search the logs for that id.
4. Check Razorpay, SES and Judge0 only after the API and database are confirmed healthy.

## 3. Deploy

Normal path: merge to `main` → **CI** → **Deploy staging** runs on its own (web to S3 and CloudFront, API and worker images to ECR, then `deploy.sh` on the host over SSM). `deploy.sh` runs `prisma migrate deploy` **before** starting the new version; a failed migration stops the deploy and leaves the running version alone. It then waits up to 60 seconds for `/health` to report the database `ok`.

Watch the run in the GitHub Actions tab. The image build normally takes about 5 minutes. If it has run past 10 minutes it is stuck: cancel it, wait for it to show cancelled, then **Re-run all jobs**.

Production deploys are not automated yet (there is only a staging workflow). **NOT YET DECIDED:** approval step and trigger for production.

## 4. Roll back

Code: open the last good **Deploy staging** run in GitHub Actions and **Re-run all jobs**. A re-run builds and deploys that run's commit, not the latest one.

**Database changes do not roll back.** Migrations only go forward. Going back to older code is safe only if the older code tolerates the newer schema. All migrations so far only add columns and tables, with one exception: `20261130100000_exam_status_cleanup` removed unused values from the `ExamStatus` enum. Code from before that migration will **not** run against a database that has had it. If a bad migration is the problem, restore the database (section 7) rather than rolling the code back.

## 5. Refund by hand

Normal path (Admin → Payments): find the payment, press **Refund**, give a reason. This sends the money back through Razorpay, reverses the trainer's share in the ledger, cancels the seat, and emails the payer. Students can also ask for a refund before they start an exam; those requests wait under **Refund requests** on the same page.

- A payment marked **needs refund** was taken but nothing was delivered (for example the exam closed while the student was paying). Refund it the same way.
- If the gateway is down, the refund fails cleanly and the payment stays **captured**; try again later.
- Last resort, only if the admin screen cannot be used: refund in the Razorpay dashboard, then record it so the books match. **NOT YET DRILLED:** there is no admin screen to record an outside refund yet, so this needs a developer to post the ledger reversal. Do not do this casually.
- Check the books afterwards: `GET /admin/finance/ledger` must show `totalPaise: 0` and an empty `unbalancedTransactions`.

## 6. Rotate secrets

Edit the parameter in SSM (`/assessiq/<environment>/<NAME>`, type SecureString), then **deploy** (re-run the latest Deploy staging run) so `deploy.sh` rewrites `.env` and restarts the containers.

| Secret                                   | Effect of changing it                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JWT_ACCESS_SECRET`                      | Access tokens signed with the old key stop working at once. Refresh tokens are separate, stored hashed, so browsers renew silently. Safe.                                                                                                                                                                                                                                                        |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Change in Razorpay first, then SSM, then deploy. Payments started before the change may fail. Do it outside exam hours.                                                                                                                                                                                                                                                                          |
| `RAZORPAY_WEBHOOK_SECRET`                | Must match the secret set on the webhook in the Razorpay dashboard. Change both within a minute of each other, or webhooks are rejected meanwhile.                                                                                                                                                                                                                                               |
| `SES_EVENTS_KEY`                         | Also update the SNS subscription URL in AWS.                                                                                                                                                                                                                                                                                                                                                     |
| `JUDGE0_AUTH_TOKEN`                      | Must match the Judge0 host.                                                                                                                                                                                                                                                                                                                                                                      |
| **`DATA_ENCRYPTION_KEY`**                | **Do not change.** It encrypts trainers' bank account numbers **and** signs every certificate. A new key makes all issued certificates fail verification and all saved bank accounts unreadable. There is no re-signing or re-encryption tool.                                                                                                                                                   |
| **`OTP_SECRET`**                         | Safe **only if `DATA_ENCRYPTION_KEY` is set separately**. If `DATA_ENCRYPTION_KEY` is not set, the code falls back to `OTP_SECRET` for the same two jobs, and changing it breaks certificates and bank accounts. **Before launch, confirm `DATA_ENCRYPTION_KEY` exists as its own SSM parameter in every environment.** Changing `OTP_SECRET` also invalidates any verification codes in flight. |
| Database password                        | Rotated by RDS through Secrets Manager. `deploy.sh` reads the current value on each deploy.                                                                                                                                                                                                                                                                                                      |

If a secret leaked, rotate it; then read `audit` rows and the request logs around the exposure for anything that should not have happened.

## 7. Restore the database — NOT YET DRILLED

RDS keeps automated backups and allows **point-in-time restore** to any moment inside the retention window. Restoring always creates a **new** instance; it never overwrites the live one.

1. Decide the target time (just before the damage). Note it in UTC.
2. Create the new instance (AWS Console → RDS → the `…-postgres` instance → Actions → Restore to point in time; or the CLI `aws rds restore-db-instance-to-point-in-time`). Use the same subnet group and the same database security group as the live instance, a new identifier such as `<live>-restore`, and no public access.
3. Wait until it is `available`. Connect from the app host (the database is private) and check the data: row counts in `User`, `Payment`, `Attempt`, `LedgerEntry`, and that `GET /admin/finance/ledger` equivalents add up to zero.
4. Switch the app to it: the deploy takes the database address from `DB_HOST` and the password from the Secrets Manager secret named in `DB_SECRET_ARN`. Point `DB_HOST` at the restored instance (and make sure the secret matches it), then deploy. Check how the deploy workflow passes these before relying on this step.
5. Keep the old instance until you are sure; then delete it. Anything written between the restore point and now is lost: tell affected users, and reconcile payments against Razorpay.

Recovery objectives today: data loss up to the last 5 minutes before the failure (point-in-time), and **hours** of downtime, since a restore takes a new instance and a manual switch. There is no standby: the database is single-AZ.

### Restore drill checklist (do this once on staging, then fill in the log)

- [ ] Restore staging to a point 1 hour ago into a new instance.
- [ ] Connect from the app host and count rows in the main tables.
- [ ] Point a throwaway API container at it and sign in.
- [ ] Switch staging to it with a normal deploy, confirm `/health`, switch back.
- [ ] Delete the restored instance.
- [ ] Write down how long each step took and anything that was not in this section.

| Date           | Who | Total time | Problems and fixes |
| -------------- | --- | ---------- | ------------------ |
| (not done yet) |     |            |                    |

## 8. Common problems

| Symptom                                                       | Likely cause and first move                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy hangs at "Build and push API and worker images"        | Stuck runner (seen once). Cancel, wait for cancelled, re-run.                                                                                                                                        |
| Deploy fails at "Deploy on the server"                        | Read the run log. A failing migration prints from `prisma migrate deploy`. The old version keeps running.                                                                                            |
| `/health` says `database: unreachable` (503)                  | RDS stopped, security group changed, or the secret changed. Check the RDS console, then the app host's `.env`.                                                                                       |
| Many students cannot sign in at once from one college         | Sign-in is limited to 10 per minute **per IP address**, and token refresh to 30 per minute per IP, so a whole class behind one network address is throttled. See `docs/LOAD_TEST.md`, "Rate limits". |
| Payments succeed at the gateway but students are not enrolled | Webhook not arriving or failing. Check Razorpay's webhook log, the `WebhookEvent` table, and the secret in section 6. Such payments show as **needs refund** in Admin → Payments.                    |
| No emails                                                     | SES still in sandbox, address bounced, or `MAIL_TRANSPORT` is not `ses`.                                                                                                                             |
| Coding answers never get graded                               | Judge0 host down or `JUDGE0_AUTH_TOKEN` mismatch.                                                                                                                                                    |
| Certificates fail verification after a deploy                 | `DATA_ENCRYPTION_KEY` (or `OTP_SECRET` if the first is unset) changed. See section 6.                                                                                                                |

## 9. Monitoring status

| Item                                                                                                                             | Status                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/health` checks the database and returns 503 when it cannot                                                                     | Done                                                                                                                                                                                                                                             |
| Structured request log with request ids                                                                                          | Done                                                                                                                                                                                                                                             |
| Unexpected errors logged with stack and request id                                                                               | Done                                                                                                                                                                                                                                             |
| Error tracking service (Sentry) on API and web                                                                                   | **Not done.** Needs a Sentry project and DSN, and an added dependency.                                                                                                                                                                           |
| CloudWatch alarms (EC2 CPU and status check, RDS CPU, free storage, connections, API 5xx, health check) with email or SMS to you | **Not done.** Needs Terraform changes applied with AWS access. Suggested first set: EC2 `StatusCheckFailed`, RDS `FreeStorageSpace` and `CPUUtilization`, RDS `DatabaseConnections`, and a Route 53 or CloudWatch Synthetics check on `/health`. |
| Uptime check from outside AWS                                                                                                    | Not done.                                                                                                                                                                                                                                        |

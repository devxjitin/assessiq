# Moving to parakh.nandivex.in

The product is **Parakh** and its address is **`parakh.nandivex.in`** (production web) with the API at
`api.parakh.nandivex.in`. Staging becomes `app-staging.parakh.nandivex.in` / `api-staging.parakh.nandivex.in`.
The code and Terraform values already say this. The live staging site still runs on the old
`assessiq.nandivex.in` names until the steps below are done (nothing has been applied yet).

## Steps (staging first)

1. **Terraform apply** (`terraform apply -var-file=envs/staging.tfvars`). It creates, for `parakh.nandivex.in`:
   - a CloudFront certificate (ACM) and aliases for `app-staging.parakh...`,
   - the API certificate and hostname for `api-staging.parakh...`,
   - a new SES identity with 3 DKIM records.
2. **GoDaddy DNS** (only the account owner can do this). Add the records Terraform prints as outputs:
   - the ACM validation CNAMEs (web and API),
   - the 3 SES DKIM CNAMEs under `_domainkey.parakh.nandivex.in`,
   - `app-staging.parakh` CNAME to the CloudFront domain, `api-staging.parakh` A record to the server IP.
3. **Email**: use a custom MAIL FROM subdomain (`mail.parakh.nandivex.in`) for SPF, not a TXT record on
   `parakh.nandivex.in` itself, because production serves the website on that exact name (a CNAME cannot
   share a name with TXT or MX records). Add DMARC at `_dmarc.parakh.nandivex.in`.
4. **Settings in AWS SSM** (`/assessiq/<env>/...`): `SES_FROM_EMAIL=no-reply@parakh.nandivex.in`,
   `VERIFY_BASE_URL=https://parakh.nandivex.in`, and the GitHub deploy variables `WEB_HOSTNAME` / `API_HOSTNAME`.
   Rebuild the web app with `NEXT_PUBLIC_API_URL=https://api-staging.parakh.nandivex.in`, then deploy.
5. **Razorpay**: set the webhook to `https://api-staging.parakh.nandivex.in/payments/webhook`.
6. Keep the old `assessiq.nandivex.in` records until the new ones work, then remove them.

## Left on purpose

Internal names keep "assessiq": the npm packages (`@assessiq/*`), AWS resource names (`assessiq-staging-...`),
SSM paths, cookies and the repository name. They are never shown to users, and renaming AWS resources means
rebuilding them. The payout-details encryption salt must never change.

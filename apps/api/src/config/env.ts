import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  OTP_SECRET: z.string().min(32, 'OTP_SECRET must be at least 32 characters'),
  // Encrypts trainers' bank account numbers. Falls back to OTP_SECRET when not set.
  DATA_ENCRYPTION_KEY: z.string().min(32).optional(),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  MAIL_TRANSPORT: z.enum(['ses', 'log', 'memory']).default('log'),
  SES_FROM_EMAIL: z.string().default('no-reply@parakh.nandivex.in'),
  SES_CONFIGURATION_SET: z.string().optional(),
  // Payments. 'fake' simulates the gateway (staging/dev only); 'razorpay' talks to the real API.
  PAYMENT_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Code execution for coding questions. 'judge0' = self-hosted Judge0, 'fake' = canned results
  // for tests/dev, 'disabled' = coding questions can be written but not run or auto-graded.
  CODE_RUNNER: z.enum(['judge0', 'fake', 'disabled']).default('disabled'),
  JUDGE0_URL: z.string().default('http://localhost:2358'),
  JUDGE0_AUTH_TOKEN: z.string().optional(),
  // 'process' works on cgroup v2 hosts (Amazon Linux 2023); 'cgroup' needs a cgroup v1 host.
  JUDGE0_LIMIT_MODE: z.enum(['process', 'cgroup']).default('process'),
  // 'on' starts the background judge that grades queued coding answers.
  CODE_JUDGE_POLL: z.enum(['on', 'off']).default('on'),
  // The public address printed on certificates (QR code and "Verify at" line) and in emails.
  // Defaults to WEB_ORIGIN. Certificates outlive any one environment, so staging can point at
  // the production address too.
  VERIFY_BASE_URL: z.string().url().optional(),
  // 'on' starts the background jobs that make certificate PDFs and email approved ones.
  CERT_JOBS_POLL: z.enum(['on', 'off']).default('on'),
  // 'on' starts the job that sends exam reminders.
  NOTIFY_JOBS_POLL: z.enum(['on', 'off']).default('on'),
  // Secret in the URL of the endpoint that receives mail bounce notices from AWS SNS.
  SES_EVENTS_KEY: z.string().min(16).optional(),
  CODE_JUDGE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  AWS_REGION: z.string().default('ap-south-1'),
  // Private file storage (exam logos, later certificates). `memory` is for tests/local dev.
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('memory'),
  S3_BUCKET: z.string().optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  ACCESS_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  OTP_TTL_MIN: z.coerce.number().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_RESEND_SECONDS: z.coerce.number().default(60),
  LOGIN_MAX_FAILURES: z.coerce.number().default(5),
  LOCK_MINUTES: z.coerce.number().default(15),
});

export type Env = z.infer<typeof schema> & { cookieSecure: boolean };

export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const env = parsed.data;
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    const missing = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].filter(
      (k) => !source[k],
    );
    if (missing.length) throw new Error(`PAYMENT_PROVIDER=razorpay needs: ${missing.join(', ')}`);
  }
  return {
    ...env,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  };
}

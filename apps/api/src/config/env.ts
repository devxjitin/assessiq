import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  OTP_SECRET: z.string().min(32, 'OTP_SECRET must be at least 32 characters'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  MAIL_TRANSPORT: z.enum(['ses', 'log', 'memory']).default('log'),
  SES_FROM_EMAIL: z.string().default('no-reply@assessiq.nandivex.in'),
  SES_CONFIGURATION_SET: z.string().optional(),
  AWS_REGION: z.string().default('ap-south-1'),
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
  return {
    ...env,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  };
}

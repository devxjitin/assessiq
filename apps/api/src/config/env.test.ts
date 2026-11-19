import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://x',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  OTP_SECRET: 'b'.repeat(32),
};
const prod = {
  ...base,
  NODE_ENV: 'production',
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'k',
  RAZORPAY_KEY_SECRET: 's',
  RAZORPAY_WEBHOOK_SECRET: 'w',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'b',
  MAIL_TRANSPORT: 'ses',
  WEB_ORIGIN: 'https://parakh.nandivex.in',
};

describe('production guards', () => {
  it('accepts a safe production config', () => {
    expect(() => loadEnv(prod)).not.toThrow();
  });
  it('allows fake defaults outside production', () => {
    expect(() => loadEnv(base)).not.toThrow();
  });
  it.each([
    ['fake payments', { PAYMENT_PROVIDER: 'fake' }],
    ['memory storage', { STORAGE_DRIVER: 'memory' }],
    ['log mail', { MAIL_TRANSPORT: 'log' }],
    ['fake code runner', { CODE_RUNNER: 'fake' }],
    ['http origin', { WEB_ORIGIN: 'http://parakh.nandivex.in' }],
  ])('refuses %s in production', (_n, over) => {
    expect(() => loadEnv({ ...prod, ...over })).toThrow(/Unsafe production/);
  });
  it('lets staging opt in to fake payments', () => {
    expect(() =>
      loadEnv({ ...prod, PAYMENT_PROVIDER: 'fake', ALLOW_FAKE_PAYMENTS: 'true' }),
    ).not.toThrow();
  });
});

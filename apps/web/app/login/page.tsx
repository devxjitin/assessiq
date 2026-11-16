'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AuthResponse } from '@assessiq/shared';
import { loginSchema } from '@assessiq/shared';
import {
  Alert,
  Button,
  Card,
  Field,
  FieldErrors,
  Shell,
  describeError,
  validate,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useRedirectIfSignedIn } from '../../lib/auth';
import { useAuth } from '../../lib/auth';

export default function LoginPage() {
  useRedirectIfSignedIn();
  const router = useRouter();
  const { setSession } = useAuth();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const result = validate(loginSchema, {
      email: form.get('email'),
      password: form.get('password'),
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError('');
    setBusy(true);
    try {
      const session = await api<AuthResponse>('/auth/login', {
        method: 'POST',
        body: result.data,
        auth: false,
      });
      setSession(session);
      router.replace('/dashboard/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        router.push(`/verify-email/?email=${encodeURIComponent(result.data.email)}`);
        return;
      }
      setFormError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Card title="Welcome back" subtitle="Sign in to your AssessIQ account.">
        <form onSubmit={onSubmit} noValidate>
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            error={errors.email}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            error={errors.password}
          />
          {formError && <Alert>{formError}</Alert>}
          <Button type="submit" loading={busy}>
            Sign in
          </Button>
        </form>
        <p className="links">
          <Link href="/forgot-password/">Forgot password?</Link>
          <Link href="/register/">Create account</Link>
        </p>
      </Card>
    </Shell>
  );
}

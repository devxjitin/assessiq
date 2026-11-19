'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { registerSchema } from '@assessiq/shared';
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
import { api } from '../../lib/api';
import { useRedirectIfSignedIn } from '../../lib/auth';

export default function RegisterPage() {
  useRedirectIfSignedIn();
  const router = useRouter();
  const [role, setRole] = useState<'STUDENT' | 'EXAMINER'>('STUDENT');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const result = validate(registerSchema, {
      role,
      name: form.get('name'),
      email: form.get('email'),
      password: form.get('password'),
      phone: (form.get('phone') as string) || undefined,
      orgName: role === 'EXAMINER' ? (form.get('orgName') as string) || undefined : undefined,
      acceptTerms: form.get('acceptTerms') === 'on',
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError('');
    setBusy(true);
    try {
      await api('/auth/register', { method: 'POST', body: result.data, auth: false });
      router.push(`/verify-email/?email=${encodeURIComponent(result.data.email)}`);
    } catch (err) {
      const d = describeError(err);
      setFormError(d.message);
      setErrors(d.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Card title="Create your account" subtitle="We will email you a code to verify your address.">
        <form onSubmit={onSubmit} noValidate>
          <div className="role-choice" role="radiogroup" aria-label="Account type">
            <label>
              <input
                type="radio"
                name="role"
                checked={role === 'STUDENT'}
                onChange={() => setRole('STUDENT')}
              />
              <strong>Student</strong>
              <small>Take exams, earn certificates</small>
            </label>
            <label>
              <input
                type="radio"
                name="role"
                checked={role === 'EXAMINER'}
                onChange={() => setRole('EXAMINER')}
              />
              <strong>Trainer</strong>
              <small>Create and run exams</small>
            </label>
          </div>
          <Field label="Full name" name="name" autoComplete="name" error={errors.name} />
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
            autoComplete="new-password"
            hint="At least 10 characters, with a letter and a number."
            error={errors.password}
          />
          <Field
            label="Phone (optional)"
            name="phone"
            type="tel"
            autoComplete="tel"
            error={errors.phone}
          />
          {role === 'EXAMINER' && (
            <Field
              label="Organisation (optional)"
              name="orgName"
              autoComplete="organization"
              error={errors.orgName}
            />
          )}
          <label className="consent">
            <input
              type="checkbox"
              name="acceptTerms"
              aria-invalid={errors.acceptTerms ? true : undefined}
            />
            <span>
              I accept the <Link href="/terms/">Terms of use</Link> and the{' '}
              <Link href="/privacy/">Privacy policy</Link>.
              {errors.acceptTerms && <small className="error-text"> {errors.acceptTerms}</small>}
            </span>
          </label>
          {formError && <Alert>{formError}</Alert>}
          <Button type="submit" loading={busy}>
            Create account
          </Button>
        </form>
        <p className="links">
          <span>
            Already registered? <Link href="/login/">Sign in</Link>
          </span>
        </p>
      </Card>
    </Shell>
  );
}

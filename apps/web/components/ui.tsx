'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '../lib/api';

export function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={wide ? 'page page-wide' : 'page'}>
      <Link href="/" className="brand">
        Assess<span>IQ</span>
      </Link>
      {children}
    </main>
  );
}

export function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <h1>{title}</h1>
      {subtitle && <p className="muted">{subtitle}</p>}
      {children}
    </section>
  );
}

export function Alert({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'success' | 'info';
  children: React.ReactNode;
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Field({
  label,
  name,
  error,
  hint,
  ...props
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} id={name} aria-invalid={error ? true : undefined} {...props} />
      {hint && !error && <small className="muted">{hint}</small>}
      {error && <small className="error-text">{error}</small>}
    </label>
  );
}

export function Button({
  loading,
  children,
  variant = 'primary',
  ...props
}: {
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn-${variant}`} disabled={loading || props.disabled} {...props}>
      {loading ? 'Please wait…' : children}
    </button>
  );
}

/** Reads ?name=value on the client (static export has no server-side search params). */
export function useQueryParam(name: string): string {
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(new URLSearchParams(window.location.search).get(name) ?? '');
  }, [name]);
  return value;
}

export type FieldErrors = Record<string, string | undefined>;

/** Validates with a shared zod schema and returns either the data or per-field messages. */
export function validate<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; errors: FieldErrors } {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

/** Turns an API error into a form message plus per-field messages. */
export function describeError(err: unknown): { message: string; fields: FieldErrors } {
  if (err instanceof ApiError) {
    const fields: FieldErrors = {};
    for (const [key, messages] of Object.entries(err.fieldErrors ?? {})) fields[key] = messages[0];
    return {
      message: err.fieldErrors ? 'Please fix the highlighted fields.' : err.message,
      fields,
    };
  }
  return {
    message: 'Could not reach the server. Check your connection and try again.',
    fields: {},
  };
}

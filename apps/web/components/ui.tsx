'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '../lib/api';
import { AppShell, Brand, ThemeToggle } from './app-shell';
import { Icon, type IconName } from './icons';

const PUBLIC_PATHS = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/verify',
];

/**
 * Page frame. Signed-out pages (landing, sign-in, ...) get a centred layout; every other page
 * gets the app shell with the sidebar and top bar.
 */
export function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  const pathname = (usePathname() ?? '/').replace(/(.)\/$/, '$1');
  if (!PUBLIC_PATHS.includes(pathname)) return <AppShell narrow={!wide}>{children}</AppShell>;
  if (pathname !== '/' && pathname !== '/verify') return <AuthShell>{children}</AuthShell>;
  return (
    <div className="public">
      <header className="public-bar">
        <Brand />
        <ThemeToggle />
      </header>
      <main className={wide ? 'page page-wide' : 'page'}>{children}</main>
    </div>
  );
}

const AUTH_POINTS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'shield',
    title: 'Proctored, fair exams',
    text: 'Full-screen mode, tab-switch strikes and a violation timeline.',
  },
  {
    icon: 'edit',
    title: 'MCQ, written and coding',
    text: 'Auto-graded choice and code questions, hand-marked written answers.',
  },
  {
    icon: 'check',
    title: 'Verified certificates',
    text: 'Publish results and issue certificates after review.',
  },
];

/** Split layout for sign-in, sign-up and password pages: brand panel on the left, form on the right. */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-side">
        <Brand light />
        <div className="auth-pitch">
          <h2>Run exams you can trust.</h2>
          <p>
            Create, proctor and grade online exams and certifications, from a ten-question quiz to a
            coding test.
          </p>
          <ul>
            {AUTH_POINTS.map((p) => (
              <li key={p.title}>
                <span className="auth-ico">
                  <Icon name={p.icon} size={18} />
                </span>
                <div>
                  <b>{p.title}</b>
                  <span>{p.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="auth-preview" aria-hidden="true">
          <div className="auth-preview-head">
            <b>Cloud Fundamentals</b>
            <span className="auth-live">Live</span>
          </div>
          <div className="auth-bar">
            <i />
          </div>
          <div className="auth-preview-row">
            <span>Question 25 of 40</span>
            <span>42:18 left</span>
          </div>
          <div className="auth-preview-row">
            <span>Tab switches</span>
            <span>0 of 3</span>
          </div>
        </div>
        <a className="auth-by" href="https://nandivex.in" target="_blank" rel="noreferrer">
          A product of NandiVex Technologies &middot; nandivex.in
        </a>
      </aside>
      <div className="auth-main">
        <header className="auth-top">
          <span className="auth-top-brand">
            <Brand />
          </span>
          <span className="spacer" />
          <ThemeToggle />
        </header>
        <main className="auth-form">{children}</main>
        <footer className="auth-foot">&copy; NandiVex Technologies</footer>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="toolbar">{children}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  note,
  icon,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
  icon: IconName;
  highlight?: boolean;
}) {
  return (
    <div className={`stat${highlight ? ' stat-hl' : ''}`}>
      <div className="stat-top">
        <span>{label}</span>
        <Icon name={icon} size={16} />
      </div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

const BADGE_KIND: Record<string, string> = {
  PAYMENT_PENDING: 'warn',
  PUBLISHED: 'info',
  LIVE: 'success',
  GRADING: 'warn',
  RESULTS_FINAL: 'success',
  CERT_PENDING_APPROVAL: 'warn',
  ACTIVE: 'success',
  SUSPENDED: 'danger',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const kind = BADGE_KIND[status];
  const text = label ?? status.replace(/_/g, ' ').toLowerCase();
  return <span className={`badge${kind ? ' badge-' + kind : ''}`}>{text}</span>;
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
  small,
  ...props
}: {
  loading?: boolean;
  small?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`btn btn-${variant}${small ? ' btn-small' : ''}`}
      disabled={loading || props.disabled}
      {...props}
    >
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

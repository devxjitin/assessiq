'use client';

import Link from 'next/link';
import { BRAND, PRICING, formatInr } from '@assessiq/shared';
import { useAuth } from '../lib/auth';
import { Shell } from '../components/ui';

export default function HomePage() {
  const { user, loading } = useAuth();
  return (
    <Shell>
      <section className="hero">
        <h1>
          Exams and certificates, <br />
          run properly.
        </h1>
        <p className="muted">
          {BRAND.PRODUCT} by {BRAND.COMPANY}: trainers publish an exam for{' '}
          {formatInr(PRICING.EXAM_CREATION_PAISE)}, students join with an exam code for{' '}
          {formatInr(PRICING.EXAM_JOIN_PAISE)} and earn a verified certificate.
        </p>
        <div className="actions">
          {!loading && user ? (
            <Link className="btn btn-primary btn-link" href="/dashboard/">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link className="btn btn-primary btn-link" href="/register/">
                Create an account
              </Link>
              <Link className="btn btn-secondary btn-link" href="/login/">
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>
    </Shell>
  );
}

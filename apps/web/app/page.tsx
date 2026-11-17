'use client';

import Link from 'next/link';
import { BRAND, PRICING, formatInr } from '@assessiq/shared';
import { useAuth } from '../lib/auth';
import { Icon } from '../components/icons';
import { Shell } from '../components/ui';

export default function HomePage() {
  const { user, loading } = useAuth();
  return (
    <Shell wide>
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
      <section className="features">
        <div className="card">
          <span className="feature-icon">
            <Icon name="exams" />
          </span>
          <h3>For trainers</h3>
          <p>
            Build exams with single, multiple-choice and written questions, or import them in bulk.
          </p>
        </div>
        <div className="card">
          <span className="feature-icon">
            <Icon name="join" />
          </span>
          <h3>For students</h3>
          <p>Join with a code, take a timed exam that saves as you go, and see your result.</p>
        </div>
        <div className="card">
          <span className="feature-icon">
            <Icon name="shield" />
          </span>
          <h3>Verified certificates</h3>
          <p>Passing students receive a certificate approved by NandiVex and delivered by email.</p>
        </div>
      </section>
    </Shell>
  );
}

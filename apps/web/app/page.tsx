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
          <p>
            Students receive a certificate of achievement and trainers a certificate of
            appreciation, each approved by NandiVex and delivered by email.
          </p>
        </div>
      </section>
      <section className="samples" aria-labelledby="samples-title">
        <h2 id="samples-title">Two certificates, both verifiable</h2>
        <p className="muted">
          Every certificate carries a serial number and a QR code. Anyone can check it on{' '}
          <Link href="/verify/">assessiq.nandivex.in/verify</Link>.
        </p>
        <div className="sample-grid">
          <figure className="sample">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/samples/certificate-student.png"
              alt="Sample Certificate of Achievement awarded to a student, with the trainer's logo, the NandiVex logo, a signature line, a serial number and a QR code"
              width={1400}
              height={990}
              loading="lazy"
            />
            <figcaption>
              <h3>For students: Certificate of Achievement</h3>
              <p>
                Awarded when a student passes. Shows the student&apos;s name, the exam, the score
                and the trainer&apos;s signature. Trainers can also give a participation certificate
                to students below the pass mark.
              </p>
              <a href="/samples/certificate-student.pdf" target="_blank" rel="noopener">
                Open sample (PDF)
              </a>
            </figcaption>
          </figure>
          <figure className="sample">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/samples/certificate-trainer.png"
              alt="Sample Certificate of Appreciation awarded to a trainer for conducting an exam, signed by NandiVex, with a serial number and a QR code"
              width={1400}
              height={990}
              loading="lazy"
            />
            <figcaption>
              <h3>For trainers: Certificate of Appreciation</h3>
              <p>
                Awarded to the trainer for conducting an exam, with the number of students who sat
                it. Signed by NandiVex Technologies.
              </p>
              <a href="/samples/certificate-trainer.pdf" target="_blank" rel="noopener">
                Open sample (PDF)
              </a>
            </figcaption>
          </figure>
        </div>
      </section>
    </Shell>
  );
}

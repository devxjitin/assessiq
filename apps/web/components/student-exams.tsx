'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AttemptDto, EnrollmentDto } from '@assessiq/shared';
import { api } from '../lib/api';
import { Alert, Button, StatusBadge, describeError } from './ui';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

export function enrollmentState(
  e: EnrollmentDto,
): 'RESULT' | 'SUBMITTED' | 'IN_PROGRESS' | 'UPCOMING' | 'MISSED' | 'READY' {
  if (e.result) return 'RESULT';
  if (e.attempt && e.attempt.status !== 'IN_PROGRESS') return 'SUBMITTED';
  if (e.attempt) return 'IN_PROGRESS';
  const now = Date.now();
  if (e.exam.startsAt && new Date(e.exam.startsAt).getTime() > now) return 'UPCOMING';
  if (e.exam.endsAt && new Date(e.exam.endsAt).getTime() <= now) return 'MISSED';
  return 'READY';
}

function statusBadge(e: EnrollmentDto) {
  switch (enrollmentState(e)) {
    case 'RESULT':
      return e.result?.passed ? (
        <StatusBadge status="LIVE" label={`Passed · ${e.result.percent}%`} />
      ) : (
        <StatusBadge status="SUSPENDED" label={`Not passed · ${e.result?.percent ?? 0}%`} />
      );
    case 'SUBMITTED':
      return <StatusBadge status="PAYMENT_PENDING" label="Submitted · awaiting results" />;
    case 'IN_PROGRESS':
      return <StatusBadge status="GRADING" label="In progress" />;
    case 'UPCOMING':
      return <StatusBadge status="PUBLISHED" label={`Opens ${when(e.exam.startsAt)}`} />;
    case 'MISSED':
      return <StatusBadge status="SUSPENDED" label="Missed" />;
    default:
      return <StatusBadge status="LIVE" label="Ready" />;
  }
}

export function StudentExams({
  items,
  loadError,
}: {
  items: EnrollmentDto[] | null;
  loadError: string;
}) {
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  async function begin(e: EnrollmentDto) {
    setError('');
    setBusyId(e.enrollmentId);
    try {
      const attempt =
        e.attempt ??
        (await api<AttemptDto>('/attempts', {
          method: 'POST',
          body: { enrollmentId: e.enrollmentId },
        }));
      window.location.href = `/attempt/?id=${attempt.id}`;
    } catch (err) {
      setError(describeError(err).message);
      setBusyId('');
    }
  }

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>My exams</h2>
      <p className="card-sub">Exams you have joined.</p>
      {(error || loadError) && <Alert>{error || loadError}</Alert>}
      {items === null && !loadError && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <div className="empty">
          <strong>No exams yet</strong>
          Enter an exam code from your trainer to join your first one.
          <div style={{ marginTop: 14 }}>
            <Link className="btn btn-primary btn-link" href="/join/">
              Join an exam
            </Link>
          </div>
        </div>
      )}
      {items?.map((e) => (
        <div className="list-row" key={e.enrollmentId}>
          <div>
            <strong>{e.exam.title}</strong>
            <div className="muted">{e.exam.durationMinutes} min</div>
          </div>
          <span className="spacer" />
          {statusBadge(e)}
          {e.result && e.attempt && (
            <Link className="btn btn-secondary btn-link" href={`/result/?id=${e.attempt.id}`}>
              View result
            </Link>
          )}
          {e.canStart && (
            <Button loading={busyId === e.enrollmentId} onClick={() => begin(e)}>
              {e.attempt ? 'Resume exam' : 'Start exam'}
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}

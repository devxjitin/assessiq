'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AttemptDto, EnrollmentDto } from '@assessiq/shared';
import { api } from '../lib/api';
import { Alert, Button, describeError } from './ui';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

function statusText(e: EnrollmentDto): string {
  if (e.attempt && e.attempt.status !== 'IN_PROGRESS') return 'Submitted';
  if (e.attempt) return 'In progress';
  const now = Date.now();
  if (e.exam.startsAt && new Date(e.exam.startsAt).getTime() > now) {
    return `Opens ${when(e.exam.startsAt)}`;
  }
  if (e.exam.endsAt && new Date(e.exam.endsAt).getTime() <= now) return 'Missed';
  return 'Ready';
}

export function StudentExams() {
  const [items, setItems] = useState<EnrollmentDto[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    api<EnrollmentDto[]>('/me/enrollments')
      .then(setItems)
      .catch(() => setError('Could not load your exams.'));
  }, []);

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
      {error && <Alert>{error}</Alert>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">You have not joined any exam yet.</p>}
      {items?.map((e) => (
        <div className="q-item" key={e.enrollmentId}>
          <div className="toolbar">
            <div>
              <strong>{e.exam.title}</strong>
              <div className="muted">
                {e.exam.durationMinutes} min · {statusText(e)}
              </div>
            </div>
            <span className="spacer" />
            {e.canStart && (
              <Button loading={busyId === e.enrollmentId} onClick={() => begin(e)}>
                {e.attempt ? 'Resume exam' : 'Start exam'}
              </Button>
            )}
          </div>
        </div>
      ))}
      <p style={{ marginBottom: 0 }}>
        <Link className="btn btn-secondary btn-link" href="/join/">
          Join an exam with a code
        </Link>
      </p>
    </section>
  );
}

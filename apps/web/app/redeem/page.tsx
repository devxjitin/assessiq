'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SeatPreviewDto } from '@assessiq/shared';
import {
  Alert,
  Button,
  PageHeader,
  Shell,
  describeError,
  useQueryParam,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'not set');

/** A student opens the link their trainer sent and joins the exam on a paid seat. */
export default function RedeemPage() {
  const { user, loading } = useRequireAuth();
  const token = useQueryParam('token');
  const [info, setInfo] = useState<SeatPreviewDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!token || user?.role !== 'STUDENT') return;
    api<SeatPreviewDto>(`/seats/preview?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((err) => setError(describeError(err).message));
  }, [token, user]);

  async function redeem() {
    setBusy(true);
    setError('');
    try {
      await api('/seats/redeem', { method: 'POST', body: { token } });
      setJoined(true);
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user) {
    return (
      <Shell wide>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }
  if (user.role !== 'STUDENT') {
    return (
      <Shell wide>
        <Alert>Exam seats are used from a student account.</Alert>
      </Shell>
    );
  }

  return (
    <Shell wide>
      <PageHeader
        title="Your exam seat"
        subtitle="Your trainer has paid for your place in this exam."
      />
      {error && <Alert>{error}</Alert>}
      {!token && <Alert>This link is missing its code. Ask your trainer to send it again.</Alert>}
      {joined ? (
        <section className="card">
          <Alert kind="success">You have joined the exam. You did not pay anything.</Alert>
          <Link className="btn btn-primary btn-link" href="/dashboard/">
            Go to my exams
          </Link>
        </section>
      ) : (
        info && (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>{info.examTitle}</h2>
            <p className="muted">
              By {info.trainerName}. Opens {when(info.startsAt)}, closes {when(info.endsAt)}.
            </p>
            {info.forEmail && (
              <p>
                This seat is reserved for <strong>{info.forEmail}</strong>.
              </p>
            )}
            <Button loading={busy} onClick={redeem}>
              Join this exam for free
            </Button>
          </section>
        )
      )}
    </Shell>
  );
}

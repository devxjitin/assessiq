'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { JoinInfoDto, PublishOrderDto } from '@assessiq/shared';
import {
  Alert,
  Button,
  PageHeader,
  Shell,
  describeError,
  useQueryParam,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';
import { runCheckout } from '../../lib/checkout';

const rupees = (paise: number) => `₹${(paise / 100).toFixed(paise % 100 ? 2 : 0)}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'not set');

const STATE_TEXT: Record<string, string> = {
  NOT_STARTED: 'You can join now and start when the exam opens.',
  ENDED: 'This exam has ended and can no longer be joined.',
  ALREADY_ENROLLED: 'You have already joined this exam.',
};

export default function JoinPage() {
  const { user, loading } = useRequireAuth();
  const queryCode = useQueryParam('code');
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<JoinInfoDto | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  const lookup = useCallback(async (value: string, keepJoined = false) => {
    setError('');
    if (!keepJoined) {
      setInfo(null);
      setJoined(false);
    }
    if (!value.trim()) return;
    setBusy(true);
    try {
      setInfo(await api<JoinInfoDto>(`/join/${encodeURIComponent(value.trim())}`));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'No exam found for that code. Check it and try again.'
          : describeError(err).message,
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (queryCode && user?.role === 'STUDENT') {
      setCode(queryCode);
      void lookup(queryCode);
    }
  }, [queryCode, user, lookup]);

  async function pay() {
    if (!info || !user) return;
    setError('');
    setNote('');
    setBusy(true);
    try {
      const order = await api<PublishOrderDto>(`/join/${encodeURIComponent(info.code)}/order`, {
        method: 'POST',
      });
      const outcome = await runCheckout(order, { name: user.name, email: user.email });
      if (outcome.simulated)
        setNote('Test mode: this payment was simulated and no money was charged.');
      if (outcome.result) {
        setJoined(true);
        await lookup(info.code, true);
      }
    } catch (err) {
      setError(
        err instanceof Error && !(err instanceof ApiError)
          ? err.message
          : describeError(err).message,
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user) {
    return (
      <Shell>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }
  if (user.role !== 'STUDENT') {
    return (
      <Shell>
        <Alert>Only student accounts can join exams.</Alert>
      </Shell>
    );
  }

  const canPay = info && (info.state === 'OPEN' || info.state === 'NOT_STARTED');

  return (
    <Shell wide>
      <PageHeader title="Join an exam" subtitle="Enter the code your trainer gave you." />
      <div className="two-eq">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Exam code</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(code);
            }}
          >
            <label className="field">
              <span>Exam code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="NVX-XXXXXX"
                autoCapitalize="characters"
                autoComplete="off"
              />
            </label>
            <Button type="submit" loading={busy && !info} disabled={!code.trim()}>
              Find exam
            </Button>
          </form>
          {error && <Alert>{error}</Alert>}
        </section>

        {info && (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>{info.title}</h2>
            <p className="muted">
              By {info.trainerName}
              {info.orgName ? `, ${info.orgName}` : ''}
            </p>
            {info.description && <p>{info.description}</p>}
            <ul className="muted" style={{ paddingLeft: 18 }}>
              <li>
                {info.questionCount} questions · {info.totalMarks} marks · {info.durationMinutes}{' '}
                minutes
              </li>
              <li>Opens: {when(info.startsAt)}</li>
              <li>Closes: {when(info.endsAt)}</li>
            </ul>
            {joined && (
              <Alert kind="success">You have joined this exam. A receipt was emailed to you.</Alert>
            )}
            {note && <Alert kind="info">{note}</Alert>}
            {STATE_TEXT[info.state] && !joined && (
              <Alert kind={info.state === 'NOT_STARTED' ? 'info' : 'error'}>
                {STATE_TEXT[info.state]}
              </Alert>
            )}
            {canPay && (
              <div>
                <p style={{ margin: '0 0 8px' }}>
                  Exam fee: <strong>{rupees(info.feePaise)}</strong>{' '}
                  <span className="muted">(inclusive of applicable taxes)</span>
                </p>
                <Button loading={busy} onClick={pay}>
                  Pay {rupees(info.feePaise)} and join
                </Button>
                <p className="muted" style={{ margin: '8px 0 0' }}>
                  See the <Link href="/refund-policy/">refund policy</Link>. If the trainer cancels
                  the exam before you start, you are refunded automatically.
                </p>
              </div>
            )}
            {info.state === 'ALREADY_ENROLLED' && (
              <Link className="btn btn-primary btn-link" href="/dashboard/">
                Go to my exams
              </Link>
            )}
          </section>
        )}
      </div>
    </Shell>
  );
}

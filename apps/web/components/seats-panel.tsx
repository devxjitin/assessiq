'use client';

import { useCallback, useEffect, useState } from 'react';
import { PRICING, type ExamDetailDto, type PublishOrderDto, type SeatsDto } from '@assessiq/shared';
import { api } from '../lib/api';
import { runCheckout } from '../lib/checkout';
import { Alert, Button, StatusBadge, describeError } from './ui';

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

const STATUS = {
  AVAILABLE: { label: 'Free', kind: 'PUBLISHED' },
  ASSIGNED: { label: 'Reserved', kind: 'PAYMENT_PENDING' },
  REDEEMED: { label: 'Used', kind: 'LIVE' },
} as const;

/** Sponsored seats: the trainer pays for students, who then join without paying. */
export function SeatsPanel({
  exam,
  userName,
  userEmail,
}: {
  exam: ExamDetailDto;
  userName: string;
  userEmail: string;
}) {
  const [data, setData] = useState<SeatsDto | null>(null);
  const [count, setCount] = useState(5);
  const [emails, setEmails] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<SeatsDto>(`/exams/${exam.id}/seats`));
    } catch (err) {
      setError(describeError(err).message);
    }
  }, [exam.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const link = (token: string) => `${window.location.origin}/redeem/?token=${token}`;

  async function seatAction(seatId: string, kind: 'resend' | 'reassign' | 'unassign') {
    setError('');
    setNote('');
    try {
      if (kind === 'resend') {
        setBusy('resend' + seatId);
        await api(`/exams/${exam.id}/seats/${seatId}/resend`, { method: 'POST' });
        setNote('Link sent again.');
      } else if (kind === 'reassign') {
        const email = window.prompt('New email address for this seat:');
        if (!email) return;
        setData(
          await api<SeatsDto>(`/exams/${exam.id}/seats/${seatId}/email`, {
            method: 'PUT',
            body: { email: email.trim() },
          }),
        );
        setNote('Seat reassigned and the new student was emailed. The old link no longer works.');
      } else {
        if (
          !window.confirm('Free this seat? The student will no longer be able to use their link.')
        )
          return;
        setData(
          await api<SeatsDto>(`/exams/${exam.id}/seats/${seatId}/email`, { method: 'DELETE' }),
        );
        setNote('Seat freed.');
      }
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy('');
    }
  }

  async function buy() {
    setBusy('buy');
    setError('');
    setNote('');
    try {
      const order = await api<PublishOrderDto>(`/exams/${exam.id}/seats/order`, {
        method: 'POST',
        body: { seats: count },
      });
      const outcome = await runCheckout(order, { name: userName, email: userEmail });
      if (outcome.result) {
        setNote(
          `${count} seat${count === 1 ? '' : 's'} bought${outcome.simulated ? ' (simulated payment: no money moved)' : ''}. A receipt was emailed to you.`,
        );
        await load();
      }
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy('');
    }
  }

  async function assign() {
    const list = emails
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    setBusy('assign');
    setError('');
    setNote('');
    try {
      setData(
        await api<SeatsDto>(`/exams/${exam.id}/seats/assign`, {
          method: 'POST',
          body: { emails: list },
        }),
      );
      setEmails('');
      setNote(`${list.length} student${list.length === 1 ? '' : 's'} emailed their link.`);
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy('');
    }
  }

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      setCopied('');
    }
  }

  const free = data ? data.seats.filter((s) => s.status === 'AVAILABLE').length : 0;
  const each = PRICING.EXAM_JOIN_PAISE;

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Pay for your students&apos; seats so they join without paying. Each seat costs{' '}
        {rupees(each)}. Email a student their personal link, or copy a link and share it yourself.
        Sponsored seats do not earn a trainer share.
      </p>
      {error && <Alert>{error}</Alert>}
      {note && <Alert kind="success">{note}</Alert>}

      <div className="toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ margin: 0, width: 140 }}>
          <span>Seats to buy</span>
          <input
            type="number"
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
          />
        </label>
        <Button loading={busy === 'buy'} onClick={buy}>
          Buy {count} seat{count === 1 ? '' : 's'} for {rupees(each * count)}
        </Button>
      </div>

      {data && data.bought > 0 && (
        <>
          <div>
            <strong>
              {data.bought} bought · {data.redeemed} used · {free} free
            </strong>
          </div>
          {data.closed && data.unused > 0 && (
            <Alert kind="info">
              The exam is over and {data.unused} seat{data.unused === 1 ? ' was' : 's were'} never
              used. Contact NandiVex support if you want to ask about a refund.
            </Alert>
          )}

          {free > 0 && (
            <div>
              <label className="field">
                <span>Email addresses of students (one per line, or separated by commas)</span>
                <textarea
                  rows={4}
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder={'asha@example.com\nravi@example.com'}
                />
              </label>
              <Button variant="secondary" loading={busy === 'assign'} onClick={assign}>
                Reserve seats and email links
              </Button>
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Status</th>
                  <th>Student</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.seats.map((s, i) => (
                  <tr key={s.id}>
                    <td>{i + 1}</td>
                    <td>
                      <StatusBadge status={STATUS[s.status].kind} label={STATUS[s.status].label} />
                    </td>
                    <td>
                      {s.status === 'REDEEMED' ? (s.redeemedByName ?? s.email) : (s.email ?? '–')}
                    </td>
                    <td>
                      {s.status !== 'REDEEMED' && (
                        <div className="toolbar">
                          <Button
                            variant="secondary"
                            small
                            onClick={() => copy(link(s.token), s.id)}
                          >
                            {copied === s.id ? 'Copied' : 'Copy link'}
                          </Button>
                          {s.email && (
                            <>
                              <Button
                                variant="secondary"
                                small
                                loading={busy === 'resend' + s.id}
                                onClick={() => void seatAction(s.id, 'resend')}
                              >
                                Resend
                              </Button>
                              <Button
                                variant="secondary"
                                small
                                onClick={() => void seatAction(s.id, 'reassign')}
                              >
                                Change email
                              </Button>
                              <Button
                                variant="secondary"
                                small
                                onClick={() => void seatAction(s.id, 'unassign')}
                              >
                                Unassign
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

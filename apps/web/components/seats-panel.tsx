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
                        <Button variant="secondary" small onClick={() => copy(link(s.token), s.id)}>
                          {copied === s.id ? 'Copied' : 'Copy link'}
                        </Button>
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

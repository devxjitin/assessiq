'use client';

import { useState } from 'react';
import {
  PRICING,
  type ExamDetailDto,
  type PublishOrderDto,
  type PublishResultDto,
} from '@assessiq/shared';
import { api } from '../lib/api';
import { Alert, Button, describeError } from './ui';

interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadCheckout(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

const rupees = (paise: number) => `₹${(paise / 100).toFixed(paise % 100 ? 2 : 0)}`;

export function PublishPanel({
  exam,
  userName,
  userEmail,
  reload,
}: {
  exam: ExamDetailDto;
  userName: string;
  userEmail: string;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState('');

  if (exam.code) {
    const link = `${window.location.origin}/join/?code=${exam.code}`;
    const copy = async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(what);
      } catch {
        setCopied('');
      }
    };
    return (
      <div className="stack">
        <Alert kind="success">
          Your exam is published
          {exam.publishedAt ? ` on ${new Date(exam.publishedAt).toLocaleString()}` : ''}. A receipt
          was emailed to you.
        </Alert>
        <div>
          <span className="muted">Exam code to share with students</span>
          <p style={{ fontSize: '2rem', letterSpacing: 4, fontWeight: 700, margin: '4px 0' }}>
            {exam.code}
          </p>
        </div>
        <div className="toolbar">
          <Button variant="secondary" onClick={() => copy(exam.code!, 'code')}>
            {copied === 'code' ? 'Copied' : 'Copy code'}
          </Button>
          <Button variant="secondary" onClick={() => copy(link, 'link')}>
            {copied === 'link' ? 'Copied' : 'Copy link'}
          </Button>
          <a
            className="btn btn-secondary btn-link"
            target="_blank"
            rel="noopener noreferrer"
            href={`https://wa.me/?text=${encodeURIComponent(`Join my exam "${exam.title}" on Parakh. Code: ${exam.code}\n${link}`)}`}
          >
            Share on WhatsApp
          </a>
        </div>
        <p className="muted">Students will be able to join with this code once joining opens.</p>
      </div>
    );
  }

  const windowMinutes =
    exam.startsAt && exam.endsAt
      ? (new Date(exam.endsAt).getTime() - new Date(exam.startsAt).getTime()) / 60000
      : 0;
  const checks: [boolean, string][] = [
    [exam.questionCount > 0, 'At least one question'],
    [Boolean(exam.startsAt && exam.endsAt), 'Open and close times are set'],
    [windowMinutes >= exam.durationMinutes, 'The open window is at least as long as the exam'],
    [
      Boolean(exam.endsAt && new Date(exam.endsAt) > new Date()),
      'The closing time is in the future',
    ],
  ];
  const ready = checks.every(([ok]) => ok);

  async function confirm(payload: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): Promise<void> {
    await api<PublishResultDto>('/payments/verify', { method: 'POST', body: payload });
    await reload();
  }

  async function pay() {
    setError('');
    setNote('');
    setBusy(true);
    try {
      const order = await api<PublishOrderDto>(`/exams/${exam.id}/publish-order`, {
        method: 'POST',
      });

      if (order.provider === 'fake') {
        setNote('Test mode: this payment is simulated and no money is charged.');
        const done = await api<{ orderId: string; paymentId: string; signature: string }>(
          '/payments/fake/complete',
          { method: 'POST', body: { orderId: order.orderId } },
        );
        await confirm(done);
        return;
      }

      if (!(await loadCheckout()) || !window.Razorpay) {
        setError('Could not load the payment window. Check your connection and try again.');
        return;
      }
      await new Promise<void>((resolve) => {
        const checkout = new window.Razorpay!({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amountPaise,
          currency: order.currency,
          name: 'Parakh by NandiVex',
          description: order.description,
          prefill: { name: userName, email: userEmail },
          handler: (r: RazorpaySuccess) => {
            confirm({
              orderId: r.razorpay_order_id,
              paymentId: r.razorpay_payment_id,
              signature: r.razorpay_signature,
            })
              .catch((err) => setError(describeError(err).message))
              .finally(resolve);
          },
          modal: { ondismiss: () => resolve() },
        });
        checkout.open();
      });
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p>
        Publishing creates your exam code. Once published, the questions and settings are locked.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {checks.map(([ok, label]) => (
          <li key={label} style={{ color: ok ? 'var(--success)' : 'var(--danger)' }}>
            {ok ? '✓' : '✗'} {label}
          </li>
        ))}
      </ul>
      {!exam.hasLogo && (
        <p className="muted">
          Optional: add a logo in the Logo tab so it appears on your students&apos; certificates.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      {note && <Alert kind="info">{note}</Alert>}
      <div>
        <p style={{ margin: '0 0 8px' }}>
          Exam creation fee: <strong>{rupees(PRICING.EXAM_CREATION_PAISE)}</strong>{' '}
          <span className="muted">(inclusive of applicable taxes)</span>
        </p>
        <Button disabled={!ready} loading={busy} onClick={pay}>
          Pay {rupees(PRICING.EXAM_CREATION_PAISE)} and publish
        </Button>
      </div>
    </div>
  );
}

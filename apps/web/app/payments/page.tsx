'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { MyPaymentDto, MyReceiptDto } from '@assessiq/shared';
import {
  Alert,
  Button,
  Card,
  PageHeader,
  Shell,
  StatusBadge,
  describeError,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '–');

function Receipt({ r, onClose }: { r: MyReceiptDto; onClose: () => void }) {
  return (
    <section className="card receipt" aria-label={`Receipt ${r.receiptNo}`}>
      <h1>Payment receipt {r.receiptNo}</h1>
      <p className="muted">Parakh by NandiVex Technologies</p>
      <table>
        <tbody>
          <tr>
            <th>Paid by</th>
            <td>
              {r.payerName} ({r.payerEmail})
            </td>
          </tr>
          <tr>
            <th>For</th>
            <td>
              {r.description}
              {r.examTitle ? `: ${r.examTitle}` : ''}
            </td>
          </tr>
          <tr>
            <th>Amount</th>
            <td>
              <strong>{rupees(r.amountPaise)}</strong> (inclusive of applicable taxes)
            </td>
          </tr>
          <tr>
            <th>Paid on</th>
            <td>{day(r.capturedAt)}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              {r.status === 'REFUNDED'
                ? `Refunded on ${day(r.refundedAt)}${r.refundReason ? ` (${r.refundReason})` : ''}`
                : 'Paid'}
            </td>
          </tr>
          {r.gatewayReference && (
            <tr>
              <th>Gateway reference</th>
              <td>{r.gatewayReference}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted">{r.note}</p>
      <div className="toolbar no-print">
        <Button onClick={() => window.print()}>Print or save as PDF</Button>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}

export default function MyPaymentsPage() {
  const { user, loading } = useRequireAuth();
  const [rows, setRows] = useState<MyPaymentDto[] | null>(null);
  const [receipt, setReceipt] = useState<MyReceiptDto | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api<MyPaymentDto[]>('/me/payments'));
      setError('');
    } catch (err) {
      setError(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    if (user && user.role !== 'ADMIN') void load();
  }, [user, load]);

  async function showReceipt(id: string) {
    setBusy('r' + id);
    try {
      setReceipt(await api<MyReceiptDto>(`/me/payments/${id}`));
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy('');
    }
  }

  async function requestRefund(p: MyPaymentDto) {
    const reason = window.prompt(
      `Ask for a refund of ${rupees(p.amountPaise)}? You can only do this before you start the exam. Why do you want it?`,
    );
    if (!reason) return;
    setBusy('f' + p.id);
    setError('');
    setNote('');
    try {
      await api(`/me/payments/${p.id}/refund-request`, { method: 'POST', body: { reason } });
      setNote('Refund requested. NandiVex will review it and email you the decision.');
      await load();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy('');
    }
  }

  if (loading || !user) {
    return (
      <Shell wide>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }
  if (user.role === 'ADMIN') {
    return (
      <Shell wide>
        <Alert>Admins see all payments under Admin &gt; Payments.</Alert>
      </Shell>
    );
  }

  return (
    <Shell wide>
      <div className="no-print">
        <PageHeader
          title="My payments"
          subtitle="Everything you have paid on Parakh, with a receipt for each."
        />
        {error && <Alert>{error}</Alert>}
        {note && <Alert kind="success">{note}</Alert>}
      </div>
      {receipt && <Receipt r={receipt} onClose={() => setReceipt(null)} />}

      <div className="no-print">
        <Card title="Payments">
          {rows === null ? (
            <p className="muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="muted">No payments yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>For</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Date</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td>{p.receiptNo}</td>
                      <td>
                        {p.description}
                        {p.examTitle && <div className="muted">{p.examTitle}</div>}
                      </td>
                      <td>{rupees(p.amountPaise)}</td>
                      <td>
                        <StatusBadge
                          status={p.status === 'REFUNDED' ? 'CANCELLED' : 'RESULTS_FINAL'}
                          label={p.status === 'REFUNDED' ? 'refunded' : 'paid'}
                        />
                        {p.refundRequest && p.status !== 'REFUNDED' && (
                          <div className="muted">
                            Refund {p.refundRequest.status.toLowerCase()}
                            {p.refundRequest.status === 'REJECTED' && p.refundRequest.decisionNote
                              ? `: ${p.refundRequest.decisionNote}`
                              : ''}
                          </div>
                        )}
                      </td>
                      <td>{day(p.capturedAt)}</td>
                      <td>
                        <div className="toolbar">
                          <Button
                            variant="secondary"
                            small
                            loading={busy === 'r' + p.id}
                            onClick={() => void showReceipt(p.id)}
                          >
                            Receipt
                          </Button>
                          {p.canRequestRefund && (
                            <Button
                              variant="secondary"
                              small
                              loading={busy === 'f' + p.id}
                              onClick={() => void requestRefund(p)}
                            >
                              Request refund
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">
            Refund rules are in the <Link href="/refund-policy/">refund policy</Link>.
          </p>
        </Card>
      </div>
    </Shell>
  );
}

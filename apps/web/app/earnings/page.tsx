'use client';

import { useCallback, useEffect, useState } from 'react';
import { payoutDetailsSchema, type EarningsDto, type PayoutDto } from '@assessiq/shared';
import {
  Alert,
  Button,
  Field,
  FieldErrors,
  PageHeader,
  Shell,
  StatCard,
  StatusBadge,
  describeError,
  validate,
} from '../../components/ui';
import { api, apiBlob } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 })}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '–');

const STATUS: Record<PayoutDto['status'], { label: string; kind: string }> = {
  REQUESTED: { label: 'Waiting for NandiVex', kind: 'PAYMENT_PENDING' },
  PAID: { label: 'Paid', kind: 'RESULTS_FINAL' },
  REJECTED: { label: 'Not paid', kind: 'SUSPENDED' },
};

function PayoutDetailsForm({
  details,
  onSaved,
}: {
  details: EarningsDto['details'];
  onSaved: () => Promise<void>;
}) {
  const [method, setMethod] = useState<'UPI' | 'BANK'>(details.method ?? 'UPI');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!details.method);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const candidate =
      method === 'UPI'
        ? { method, upiId: String(f.get('upiId') ?? '') }
        : {
            method,
            accountName: String(f.get('accountName') ?? ''),
            accountNumber: String(f.get('accountNumber') ?? ''),
            ifsc: String(f.get('ifsc') ?? ''),
          };
    const result = validate(payoutDetailsSchema, candidate);
    setSaved(false);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setMessage('');
    setBusy(true);
    try {
      await api('/earnings/payout-details', { method: 'PUT', body: result.data });
      setSaved(true);
      setEditing(false);
      await onSaved();
    } catch (err) {
      const d = describeError(err);
      setMessage(d.message);
      setErrors(d.fields);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div>
        <p style={{ margin: '0 0 8px' }}>
          {details.method === 'UPI' ? (
            <>
              UPI: <strong>{details.upiId}</strong>
            </>
          ) : (
            <>
              Bank: <strong>{details.accountName}</strong>, account{' '}
              <strong>{details.accountMasked}</strong>, IFSC <strong>{details.ifsc}</strong>
            </>
          )}{' '}
          {details.verifiedAt ? (
            <StatusBadge status="LIVE" label="Checked by NandiVex" />
          ) : (
            <StatusBadge status="PAYMENT_PENDING" label="Not checked yet" />
          )}
        </p>
        {saved && <Alert kind="success">Saved.</Alert>}
        <Button variant="secondary" small onClick={() => setEditing(true)}>
          Change details
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        {(['UPI', 'BANK'] as const).map((m) => (
          <label className="check" key={m}>
            <input
              type="radio"
              name="method"
              checked={method === m}
              onChange={() => setMethod(m)}
            />
            {m === 'UPI' ? 'UPI id' : 'Bank account'}
          </label>
        ))}
      </div>
      {method === 'UPI' ? (
        <Field
          label="UPI id"
          name="upiId"
          placeholder="name@bank"
          defaultValue={details.upiId ?? ''}
          error={errors.upiId}
        />
      ) : (
        <>
          <Field
            label="Name on the account"
            name="accountName"
            defaultValue={details.accountName ?? ''}
            error={errors.accountName}
          />
          <Field
            label="Account number"
            name="accountNumber"
            inputMode="numeric"
            autoComplete="off"
            hint="Stored encrypted. Only the last four digits are shown later."
            error={errors.accountNumber}
          />
          <Field
            label="IFSC code"
            name="ifsc"
            defaultValue={details.ifsc ?? ''}
            error={errors.ifsc}
          />
        </>
      )}
      {message && <Alert>{message}</Alert>}
      <div className="toolbar">
        <Button type="submit" loading={busy}>
          Save payout details
        </Button>
        {details.method && (
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export default function EarningsPage() {
  const { user, loading } = useRequireAuth();
  const [data, setData] = useState<EarningsDto | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<EarningsDto>('/earnings'));
      setError('');
    } catch (err) {
      setError(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'EXAMINER') void load();
  }, [user, load]);

  async function request() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await api('/payouts/request', { method: 'POST' });
      setNote('Payout requested. NandiVex will pay it and email you the reference.');
      await load();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function statement(p: PayoutDto) {
    try {
      const blob = await apiBlob(`/payouts/${p.id}/statement.csv`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payout-${p.id.slice(0, 8)}-statement.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(describeError(err).message);
    }
  }

  if (loading || !user) {
    return (
      <Shell wide>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }
  if (user.role !== 'EXAMINER') {
    return (
      <Shell wide>
        <Alert>Earnings are for trainers.</Alert>
      </Shell>
    );
  }

  const b = data?.balances;
  const canRequest = Boolean(
    b && data && data.details.method && b.payablePaise >= b.minPayoutPaise && b.pendingPaise === 0,
  );

  return (
    <Shell wide>
      <PageHeader
        title="Earnings"
        subtitle="You earn 50% of every fee students pay to join your exams. NandiVex pays it out by UPI or bank transfer."
      />
      {error && <Alert>{error}</Alert>}
      {note && <Alert kind="success">{note}</Alert>}
      {!data || !b ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="stack">
          <div className="stats">
            <StatCard
              label="Payable now"
              value={rupees(b.payablePaise)}
              note={`payouts start at ${rupees(b.minPayoutPaise)}`}
              icon="check"
              highlight
            />
            <StatCard
              label="Accruing"
              value={rupees(b.accruedPaise)}
              note="payable once results are published"
              icon="clock"
            />
            <StatCard
              label="Requested"
              value={rupees(b.pendingPaise)}
              note="waiting for NandiVex"
              icon="zap"
            />
            <StatCard
              label="Paid so far"
              value={rupees(b.paidPaise)}
              note="all time"
              icon="shield"
            />
          </div>

          {b.owedBackPaise > 0 && (
            <Alert kind="info">
              {rupees(b.owedBackPaise)} was refunded to students after you were paid. It will be
              taken from your next earnings.
            </Alert>
          )}

          <section className="card">
            <h2 style={{ marginTop: 0 }}>Where to send your money</h2>
            <PayoutDetailsForm details={data.details} onSaved={load} />
          </section>

          <section className="card">
            <div className="toolbar">
              <h2 style={{ margin: 0 }}>Payouts</h2>
              <span className="spacer" />
              <Button loading={busy} disabled={!canRequest} onClick={request}>
                Request payout
              </Button>
            </div>
            {!data.details.method && (
              <p className="muted">Add your UPI id or bank account above to request a payout.</p>
            )}
            {data.payouts.length === 0 ? (
              <p className="muted">No payouts yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Requested</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Sent to</th>
                      <th>Reference (UTR)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.payouts.map((p) => (
                      <tr key={p.id}>
                        <td>{day(p.requestedAt)}</td>
                        <td>{rupees(p.amountPaise)}</td>
                        <td>
                          <StatusBadge
                            status={STATUS[p.status].kind}
                            label={STATUS[p.status].label}
                          />
                          {p.note && p.status === 'REJECTED' && (
                            <div className="muted">{p.note}</div>
                          )}
                        </td>
                        <td>{p.destination ?? '–'}</td>
                        <td>{p.utr ?? '–'}</td>
                        <td>
                          {p.status === 'PAID' && (
                            <Button variant="secondary" small onClick={() => statement(p)}>
                              Statement
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2 style={{ marginTop: 0 }}>Earnings by exam</h2>
            {data.exams.length === 0 ? (
              <p className="muted">Earnings appear here once students join your published exams.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Exam</th>
                      <th>Students paid</th>
                      <th>Collected</th>
                      <th>Your share</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.exams.map((e) => (
                      <tr key={e.examId}>
                        <td>{e.title}</td>
                        <td>{e.joins}</td>
                        <td>{rupees(e.grossPaise)}</td>
                        <td>{rupees(e.sharePaise)}</td>
                        <td>
                          <StatusBadge
                            status={e.state === 'PAYABLE' ? 'LIVE' : 'PAYMENT_PENDING'}
                            label={e.state === 'PAYABLE' ? 'Payable' : 'Accruing'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">
              Seats you buy for your own students are not counted here: they carry no trainer share.
            </p>
          </section>
        </div>
      )}
    </Shell>
  );
}

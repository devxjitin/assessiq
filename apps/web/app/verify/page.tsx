'use client';

import { useEffect, useState } from 'react';
import { CERT_KIND_TITLE, type VerifyCertificateDto } from '@assessiq/shared';
import { Button, Shell, useQueryParam } from '../../components/ui';
import { API_URL } from '../../lib/api';

const day = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';

/** Public: anyone (an employer, a college) can check a certificate. No sign-in. */
export default function VerifyPage() {
  const fromLink = useQueryParam('serial');
  const [serial, setSerial] = useState('');
  const [result, setResult] = useState<VerifyCertificateDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function check(value: string) {
    const s = value.trim();
    if (!s) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/verify/${encodeURIComponent(s)}`);
      if (!res.ok) throw new Error('failed');
      setResult((await res.json()) as VerifyCertificateDto);
    } catch {
      setError('Could not check right now. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (fromLink) {
      setSerial(fromLink);
      void check(fromLink);
    }
  }, [fromLink]);

  return (
    <Shell>
      <section className="card">
        <h1>Check a certificate</h1>
        <p className="muted">
          Enter the serial number printed on the certificate, or scan its QR code.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void check(serial);
          }}
        >
          <label className="field">
            <span>Serial number</span>
            <input
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              placeholder="PRK-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button type="submit" loading={busy}>
            Check
          </Button>
        </form>

        {error && <div className="alert alert-error">{error}</div>}

        {result?.state === 'VALID' && (
          <div className="alert alert-success" role="status" style={{ marginTop: 16 }}>
            <strong>This certificate is genuine.</strong>
            <dl className="kv" style={{ marginBottom: 0 }}>
              <dt>Awarded to</dt>
              <dd>{result.holderName}</dd>
              <dt>Certificate</dt>
              <dd>{result.kind ? CERT_KIND_TITLE[result.kind] : ''}</dd>
              <dt>Exam</dt>
              <dd>{result.examTitle}</dd>
              {result.organisation && (
                <>
                  <dt>Conducted by</dt>
                  <dd>{result.organisation}</dd>
                </>
              )}
              <dt>Issued</dt>
              <dd>{day(result.issuedOn)}</dd>
              <dt>Serial</dt>
              <dd>{result.serialNo}</dd>
            </dl>
          </div>
        )}
        {result?.state === 'REVOKED' && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 16 }}>
            <strong>This certificate was withdrawn.</strong> It is no longer valid. Contact the
            issuer if you have questions.
          </div>
        )}
        {result?.state === 'NOT_FOUND' && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 16 }}>
            <strong>No certificate found with this serial number.</strong> Check the number and try
            again. If it is correct, the certificate is not genuine.
          </div>
        )}
      </section>
    </Shell>
  );
}

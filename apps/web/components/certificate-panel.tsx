'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CERT_ACCENTS,
  CERT_LAYOUTS,
  type CertAccent,
  type CertLayout,
  type CertificateTemplate,
  type ExamDetailDto,
  type TrainerCertificatesDto,
} from '@assessiq/shared';
import { api, apiBlob } from '../lib/api';
import { Alert, Button, StatusBadge, describeError } from './ui';

/** The trainer designs the exam's certificate and sees a live PDF preview. */
export function CertificatePanel({
  exam,
  reload,
}: {
  exam: ExamDetailDto;
  reload: () => Promise<void>;
}) {
  const [info, setInfo] = useState<TrainerCertificatesDto | null>(null);
  const [tpl, setTpl] = useState<CertificateTemplate | null>(null);
  const [kind, setKind] = useState<'ACHIEVEMENT' | 'PARTICIPATION' | 'TRAINER'>('ACHIEVEMENT');
  const [previewUrl, setPreviewUrl] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef('');

  const load = useCallback(async () => {
    try {
      const v = await api<TrainerCertificatesDto>(`/exams/${exam.id}/certificate`);
      setInfo(v);
      setTpl(v.template);
    } catch (err) {
      setError(describeError(err).message);
    }
  }, [exam.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Redraw the preview shortly after each change.
  useEffect(() => {
    if (!tpl) return;
    const t = setTimeout(async () => {
      try {
        const blob = await apiBlob(`/exams/${exam.id}/certificate/preview?kind=${kind}`, {
          method: 'POST',
          body: tpl,
        });
        const url = URL.createObjectURL(blob);
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = url;
        setPreviewUrl(url);
      } catch (err) {
        setError(describeError(err).message);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [tpl, kind, exam.id]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  if (!info || !tpl) return error ? <Alert>{error}</Alert> : <p className="muted">Loading…</p>;
  const locked = info.finalized;
  const set = <K extends keyof CertificateTemplate>(k: K, v: CertificateTemplate[K]) =>
    setTpl({ ...tpl, [k]: v });

  async function save() {
    if (!tpl) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const v = await api<TrainerCertificatesDto>(`/exams/${exam.id}/certificate`, {
        method: 'PUT',
        body: tpl,
      });
      setInfo(v);
      setTpl(v.template);
      setNote('Certificate design saved.');
      await reload();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}
      {note && <Alert kind="success">{note}</Alert>}
      {locked ? (
        <Alert kind="info">
          Results are published, so the design is locked.{' '}
          {info.total === 0
            ? 'No certificates were made for this exam.'
            : `${info.total} certificates: ${info.waiting} waiting for NandiVex approval, ${info.issued} issued${info.rejected ? `, ${info.rejected} not issued` : ''}.`}
        </Alert>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          When you publish results, each student gets a certificate with your logo and the NandiVex
          logo, and you get a Certificate of Appreciation for conducting the exam. NandiVex checks
          them all before they are emailed.
        </p>
      )}

      <div className="cert-designer">
        <div>
          <label className="check">
            <input
              type="checkbox"
              checked={tpl.enabled}
              disabled={locked}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            Give certificates for this exam
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={tpl.trainerCertificate}
              disabled={locked || !tpl.enabled}
              onChange={(e) => set('trainerCertificate', e.target.checked)}
            />
            Give <strong>me</strong> a Certificate of Appreciation for conducting this exam
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={tpl.participation}
              disabled={locked || !tpl.enabled}
              onChange={(e) => set('participation', e.target.checked)}
            />
            Also give a Certificate of Participation to students below the pass mark (
            {exam.passPercent}%)
          </label>

          <label className="field">
            <span>Layout</span>
            <select
              value={tpl.layout}
              disabled={locked}
              onChange={(e) => set('layout', e.target.value as CertLayout)}
            >
              {(Object.keys(CERT_LAYOUTS) as CertLayout[]).map((l) => (
                <option key={l} value={l}>
                  {CERT_LAYOUTS[l]}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>Colour</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(Object.keys(CERT_ACCENTS) as CertAccent[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  title={CERT_ACCENTS[a].label}
                  aria-label={CERT_ACCENTS[a].label}
                  aria-pressed={tpl.accent === a}
                  disabled={locked}
                  onClick={() => set('accent', a)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: CERT_ACCENTS[a].hex,
                    border: tpl.accent === a ? '3px solid var(--text)' : '2px solid var(--border)',
                    cursor: locked ? 'default' : 'pointer',
                  }}
                />
              ))}
            </div>
          </div>

          <label className="field">
            <span>Heading (optional)</span>
            <input
              value={tpl.title ?? ''}
              maxLength={60}
              disabled={locked}
              placeholder="Certificate of Achievement"
              onChange={(e) => set('title', e.target.value || null)}
            />
          </label>
          <label className="field">
            <span>Sentence under the name (optional)</span>
            <input
              value={tpl.message ?? ''}
              maxLength={200}
              disabled={locked}
              placeholder="has successfully passed the exam"
              onChange={(e) => set('message', e.target.value || null)}
            />
          </label>
          <label className="field">
            <span>Signatory name</span>
            <input
              value={tpl.signatoryName ?? ''}
              maxLength={60}
              disabled={locked}
              onChange={(e) => set('signatoryName', e.target.value || null)}
            />
          </label>
          <label className="field">
            <span>Signatory title</span>
            <input
              value={tpl.signatoryTitle ?? ''}
              maxLength={60}
              disabled={locked}
              placeholder="e.g. Director"
              onChange={(e) => set('signatoryTitle', e.target.value || null)}
            />
          </label>
          <p className="muted">
            Your logo comes from the Logo tab (or your account logo). Use the Latin alphabet in
            these fields: other scripts cannot be drawn on the certificate yet.
          </p>
          {!locked && (
            <Button loading={busy} onClick={save}>
              Save certificate design
            </Button>
          )}
        </div>

        <div>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <strong>Preview</strong>
            <StatusBadge status="PUBLISHED" label="sample" />
            <span className="spacer" />
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="ACHIEVEMENT">Achievement (passed)</option>
              <option value="PARTICIPATION">Participation (below pass mark)</option>
              <option value="TRAINER">Trainer (appreciation)</option>
            </select>
          </div>
          {previewUrl ? (
            <iframe
              title="Certificate preview"
              src={`${previewUrl}#toolbar=0&navpanes=0`}
              style={{
                width: '100%',
                aspectRatio: '1.414',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: '#fff',
              }}
            />
          ) : (
            <p className="muted">Drawing the preview…</p>
          )}
        </div>
      </div>
    </div>
  );
}

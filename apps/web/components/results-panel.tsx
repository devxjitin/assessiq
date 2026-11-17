'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  FLAG_TEXT,
  type ExamDetailDto,
  type ExamResultsDto,
  type IntegrityFlagCode,
  type SimilarityReportDto,
} from '@assessiq/shared';
import { api, apiBlob } from '../lib/api';
import { Alert, Button, StatCard, StatusBadge, describeError } from './ui';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '–');

function rowStatus(r: ExamResultsDto['rows'][number]) {
  if (r.status === 'IN_PROGRESS') return <StatusBadge status="LIVE" label="Taking exam" />;
  if (r.pendingGrading > 0) {
    return <StatusBadge status="PAYMENT_PENDING" label={`${r.pendingGrading} to mark`} />;
  }
  if (r.status === 'RESULT_PUBLISHED')
    return <StatusBadge status="RESULTS_FINAL" label="Published" />;
  return <StatusBadge status="PUBLISHED" label="Marked" />;
}

const FLAG_LABEL: Record<IntegrityFlagCode, { text: string; kind: string }> = {
  DEVICE_MISMATCH: { text: 'Other device blocked', kind: 'danger' },
  SHARED_DEVICE: { text: 'Shared device', kind: 'warn' },
  NETWORK_CHANGED: { text: 'Network changed', kind: 'info' },
  NO_DEVICE_ID: { text: 'No device id', kind: 'warn' },
};

export function FlagBadges({ flags }: { flags: IntegrityFlagCode[] }) {
  if (flags.length === 0) return <span className="muted">–</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {flags.map((f) => (
        <span key={f} className={`badge badge-${FLAG_LABEL[f].kind}`} title={FLAG_TEXT[f]}>
          {FLAG_LABEL[f].text}
        </span>
      ))}
    </span>
  );
}

/** Pairs of coding answers that look copied from each other. Advisory: a person decides. */
function SimilarityPanel({ examId }: { examId: string }) {
  const [report, setReport] = useState<SimilarityReportDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function check() {
    setBusy(true);
    setError('');
    try {
      setReport(await api<SimilarityReportDto>(`/exams/${examId}/similarity`));
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Copied code check</h2>
      <p className="muted">
        Compares coding answers between students. Names, spacing and comments are ignored, so a
        renamed copy still shows up. A high match is a reason to look, not proof: short or very
        standard solutions can match by chance.
      </p>
      <Button variant="secondary" loading={busy} onClick={check}>
        {report ? 'Check again' : 'Check for copied code'}
      </Button>
      {error && <Alert>{error}</Alert>}
      {report?.questions.map((q) => (
        <div key={q.questionId} style={{ marginTop: 16 }}>
          <strong>Question {q.number}</strong>{' '}
          <span className="muted">
            {q.body} · {q.compared} answers compared
          </span>
          {q.pairs.length === 0 ? (
            <p className="muted">
              No pairs at {Math.round(report.threshold * 100)}% or more alike.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Alike</th>
                    <th>Student</th>
                    <th>Student</th>
                  </tr>
                </thead>
                <tbody>
                  {q.pairs.map((p) => (
                    <tr key={p.a.attemptId + p.b.attemptId}>
                      <td>
                        <StatusBadge
                          status={p.similarity >= 95 ? 'SUSPENDED' : 'PAYMENT_PENDING'}
                          label={`${p.similarity}%`}
                        />
                      </td>
                      {[p.a, p.b].map((s) => (
                        <td key={s.attemptId}>
                          <Link href={`/exams/grade/?exam=${examId}&attempt=${s.attemptId}`}>
                            {s.name}
                          </Link>
                          <div className="muted">{s.email}</div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

export function ResultsPanel({
  exam,
  reload,
}: {
  exam: ExamDetailDto;
  reload: () => Promise<void>;
}) {
  const [data, setData] = useState<ExamResultsDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<ExamResultsDto>(`/exams/${exam.id}/results`));
      setError('');
    } catch (err) {
      setError(describeError(err).message);
    }
  }, [exam.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish() {
    if (
      !window.confirm(
        'Publish results? Students will see their score and answers, and marks can no longer be changed.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      setData(await api<ExamResultsDto>(`/exams/${exam.id}/finalize`, { method: 'POST' }));
      await reload();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function release(attemptId: string, name: string) {
    if (
      !window.confirm(
        `Let ${name} continue this exam on a different device? The device they are using now will be locked out.`,
      )
    )
      return;
    try {
      await api(`/exams/${exam.id}/attempts/${attemptId}/release-device`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(describeError(err).message);
    }
  }

  async function exportCsv() {
    try {
      const blob = await apiBlob(`/exams/${exam.id}/results.csv`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exam.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-results.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(describeError(err).message);
    }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <p className="muted">Loading…</p>;
  const { stats } = data;

  return (
    <div className="stack">
      <div className="stats">
        <StatCard
          label="Attempts"
          value={stats.attempts}
          note={`of ${data.exam.enrolled} who joined`}
          icon="users"
          highlight
        />
        <StatCard
          label="Submitted"
          value={stats.submitted}
          note={`${stats.inProgress} still taking`}
          icon="check"
        />
        <StatCard
          label="Average score"
          value={stats.average === null ? '–' : `${stats.average} / ${data.exam.totalMarks}`}
          note={stats.highest === null ? 'no marked attempts yet' : `highest ${stats.highest}`}
          icon="zap"
        />
        <StatCard
          label="Pass rate"
          value={stats.passRate === null ? '–' : `${stats.passRate}%`}
          note={`pass mark ${data.exam.passPercent}%`}
          icon="shield"
        />
      </div>

      {error && <Alert>{error}</Alert>}
      {data.exam.questionsPerStudent && (
        <Alert kind="info">
          Question pool: each student gets {data.exam.questionsPerStudent} random questions, so
          totals shown here are for a typical student.
        </Alert>
      )}
      {data.finalized ? (
        <Alert kind="success">Results are published. Students can see their scores.</Alert>
      ) : stats.pendingGrading > 0 ? (
        <Alert kind="info">
          {stats.pendingGrading} written answer{stats.pendingGrading === 1 ? '' : 's'} still need
          marks. Results can be published after you mark them and the exam has closed.
        </Alert>
      ) : null}

      <div className="toolbar">
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
        <Button variant="secondary" onClick={exportCsv}>
          Export CSV
        </Button>
        <span className="spacer" />
        {!data.finalized && (
          <Button loading={busy} onClick={publish}>
            Publish results
          </Button>
        )}
      </div>

      {data.rows.length === 0 ? (
        <div className="empty">
          <strong>No attempts yet</strong>
          Attempts appear here as students start the exam.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Student</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>Score</th>
                <th>Result</th>
                <th>Strikes</th>
                <th>Events</th>
                <th>Integrity</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.attemptId}>
                  <td>
                    <strong>{r.studentName}</strong>
                    <div className="muted">{r.studentEmail}</div>
                  </td>
                  <td>{rowStatus(r)}</td>
                  <td>{when(r.submittedAt)}</td>
                  <td>
                    {r.score === null ? '–' : `${r.score} / ${r.maxScore ?? data.exam.totalMarks}`}
                    {r.percent !== null && <div className="muted">{r.percent}%</div>}
                  </td>
                  <td>
                    {r.passed === null ? (
                      '–'
                    ) : (
                      <StatusBadge
                        status={r.passed ? 'LIVE' : 'SUSPENDED'}
                        label={r.passed ? 'Pass' : 'Fail'}
                      />
                    )}
                  </td>
                  <td>{r.strikes}</td>
                  <td>{r.violations}</td>
                  <td>
                    <FlagBadges flags={r.flags} />
                  </td>
                  <td>
                    {r.status === 'IN_PROGRESS' && (
                      <Button
                        variant="secondary"
                        onClick={() => void release(r.attemptId, r.studentName)}
                      >
                        Release device
                      </Button>
                    )}
                    {r.status !== 'IN_PROGRESS' && (
                      <Link
                        className="btn btn-secondary btn-small btn-link"
                        href={`/exams/grade/?exam=${exam.id}&attempt=${r.attemptId}`}
                      >
                        {r.pendingGrading > 0 && !data.finalized ? 'Mark' : 'View'}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {exam.questions.some((q) => q.type === 'CODING') && <SimilarityPanel examId={exam.id} />}
    </div>
  );
}

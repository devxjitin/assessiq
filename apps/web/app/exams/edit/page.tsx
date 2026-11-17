'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ExamDetailDto, ExamQuestionDto } from '@assessiq/shared';
import { ExamSettingsForm } from '../../../components/exam-settings-form';
import { PublishPanel } from '../../../components/publish-panel';
import { ResultsPanel } from '../../../components/results-panel';
import { SeatsPanel } from '../../../components/seats-panel';
import { QuestionEditor } from '../../../components/question-editor';
import {
  Alert,
  Button,
  Shell,
  StatusBadge,
  describeError,
  useQueryParam,
} from '../../../components/ui';
import { ApiError, api, apiBlob } from '../../../lib/api';
import { useRequireAuth } from '../../../lib/auth';

type Tab = 'questions' | 'import' | 'settings' | 'logo' | 'publish' | 'seats' | 'results';

const TYPE_LABEL = {
  SINGLE: 'One correct',
  MULTI: 'Several correct',
  SUBJECTIVE: 'Subjective',
  CODING: 'Coding',
} as const;

interface ImportResult {
  committed: boolean;
  found: number;
  importable: number;
  questions: { type: string; body: string; options: string[]; correctOptions: number[] }[];
}

function QuestionsTab({
  exam,
  reload,
  locked,
}: {
  exam: ExamDetailDto;
  reload: () => Promise<void>;
  locked: boolean;
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const base = `/exams/${exam.id}`;

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await reload();
    } catch (err) {
      setError(describeError(err).message);
    }
  }

  const move = (index: number, delta: number) => {
    const ids = exam.questions.map((q) => q.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    return run(() => api(`${base}/questions-order`, { method: 'PUT', body: { questionIds: ids } }));
  };

  return (
    <div>
      {error && <Alert>{error}</Alert>}
      {exam.questions.map((q: ExamQuestionDto, i) =>
        editing === q.id ? (
          <QuestionEditor
            key={q.id}
            initial={q}
            onCancel={() => setEditing(null)}
            onSave={async (input) => {
              await api(`${base}/questions/${q.id}`, { method: 'PUT', body: input });
              setEditing(null);
              await reload();
            }}
          />
        ) : (
          <div className="q-item" key={q.id}>
            <div className="toolbar">
              <strong>Q{q.position}</strong>
              <span className="badge">{TYPE_LABEL[q.type]}</span>
              <span className="muted">
                {q.marks} marks{q.negativeMarks ? `, −${q.negativeMarks} if wrong` : ''}
              </span>
              <span className="spacer" />
              {!locked && (
                <>
                  <Button
                    variant="secondary"
                    small
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="secondary"
                    small
                    disabled={i === exam.questions.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label="Move down"
                  >
                    ↓
                  </Button>
                  <Button variant="secondary" small onClick={() => setEditing(q.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    small
                    onClick={() =>
                      window.confirm(`Delete question ${q.position}?`) &&
                      run(() => api(`${base}/questions/${q.id}`, { method: 'DELETE' }))
                    }
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
            <div className="q-body">{q.body}</div>
            {q.options.length > 0 && (
              <ul className="q-options">
                {q.options.map((o, idx) => (
                  <li key={idx} className={q.correctOptions.includes(idx) ? 'correct' : ''}>
                    {String.fromCharCode(65 + idx)}. {o}
                  </li>
                ))}
              </ul>
            )}
            {q.rubric && <p className="muted">Guidance: {q.rubric}</p>}
            {q.coding && (
              <p className="muted">
                {q.coding.languages.join(', ')} ·{' '}
                {q.coding.testCases.filter((t) => !t.hidden).length} sample and{' '}
                {q.coding.testCases.filter((t) => t.hidden).length} hidden test cases ·{' '}
                {q.coding.timeLimitMs / 1000}s, {q.coding.memoryMb} MB
              </p>
            )}
          </div>
        ),
      )}
      {exam.questions.length === 0 && editing !== 'new' && (
        <p className="muted">
          No questions yet. Add one, or use the Import tab to paste many at once.
        </p>
      )}
      {editing === 'new' ? (
        <QuestionEditor
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            await api(`${base}/questions`, { method: 'POST', body: input });
            setEditing(null);
            await reload();
          }}
        />
      ) : (
        !locked && (
          <div style={{ marginTop: 12 }}>
            <Button onClick={() => setEditing('new')}>Add question</Button>
          </div>
        )
      )}
    </div>
  );
}

function ImportTab({
  exam,
  reload,
  locked,
}: {
  exam: ExamDetailDto;
  reload: () => Promise<void>;
  locked: boolean;
}) {
  const [text, setText] = useState('');
  const [marks, setMarks] = useState('4');
  const [negative, setNegative] = useState('0');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(commit: boolean) {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const res = await api<ImportResult>(`/exams/${exam.id}/questions-import`, {
        method: 'POST',
        body: { text, defaultMarks: Number(marks), defaultNegativeMarks: Number(negative), commit },
      });
      setResult(commit ? null : res);
      if (commit) {
        setText('');
        setDone(`Imported ${res.found} questions.`);
        await reload();
      }
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  if (locked) return <Alert kind="info">This exam can no longer be changed.</Alert>;

  return (
    <div className="stack">
      <p className="muted">
        Paste questions as plain text. Number each question, label options A, B, C…, and add an{' '}
        <span className="mono">Answer: B</span> line (use <span className="mono">Answer: A, C</span>{' '}
        for several correct answers). An <span className="mono">Explanation:</span> line is
        optional.
      </p>
      <pre
        className="q-item mono"
        style={{ whiteSpace: 'pre-wrap' }}
      >{`Question 1: Which port does HTTPS use?
A. 80
B. 443
C. 22
Answer: B
Explanation: TLS runs on 443.`}</pre>
      {error && <Alert>{error}</Alert>}
      {done && <Alert kind="success">{done}</Alert>}
      <label className="field">
        <span>Questions</span>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          style={{ minHeight: 220 }}
        />
      </label>
      <div className="row">
        <label className="field">
          <span>Marks per question</span>
          <input
            type="number"
            min={0}
            step="0.25"
            value={marks}
            onChange={(e) => setMarks(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Negative marks per question</span>
          <input
            type="number"
            min={0}
            step="0.25"
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
          />
        </label>
      </div>
      <div className="toolbar">
        <Button
          variant="secondary"
          loading={busy}
          disabled={!text.trim()}
          onClick={() => send(false)}
        >
          Check the text
        </Button>
        {result && (
          <Button loading={busy} onClick={() => send(true)}>
            Import {result.found} questions
          </Button>
        )}
      </div>
      {result && (
        <Alert kind="info">
          Found {result.found} questions (
          {result.questions.filter((q) => q.type === 'MULTI').length} with several correct answers).
          First one: “{result.questions[0].body.slice(0, 120)}”. Check the answers, then import.
        </Alert>
      )}
    </div>
  );
}

function LogoTab({
  exam,
  reload,
  locked,
}: {
  exam: ExamDetailDto;
  reload: () => Promise<void>;
  locked: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    if (exam.hasLogo) {
      apiBlob(`/exams/${exam.id}/logo`)
        .then((blob) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [exam.id, exam.hasLogo, exam.updatedAt]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError('');
    if (file.size > 512 * 1024) return setError('The logo must be 512 KB or smaller.');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api(`/exams/${exam.id}/logo`, { method: 'PUT', body: form });
      await reload();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted">
        Your logo appears on the certificates for this exam, next to the NandiVex logo. Use a PNG or
        JPEG, up to 512 KB.
      </p>
      {error && <Alert>{error}</Alert>}
      {url && <img className="logo-preview" src={url} alt="Exam logo" />}
      {!exam.hasLogo && <p className="muted">No logo yet.</p>}
      {!locked && (
        <div className="toolbar">
          <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
            {busy ? 'Uploading…' : exam.hasLogo ? 'Replace logo' : 'Upload logo'}
            <input
              type="file"
              accept="image/png,image/jpeg"
              hidden
              disabled={busy}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {exam.hasLogo && (
            <Button
              variant="danger"
              onClick={() => api(`/exams/${exam.id}/logo`, { method: 'DELETE' }).then(reload)}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function EditExamPage() {
  const { user, loading } = useRequireAuth();
  const id = useQueryParam('id');
  const [exam, setExam] = useState<ExamDetailDto | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('questions');

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      setExam(await api<ExamDetailDto>(`/exams/${id}`));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'Exam not found.'
          : 'Could not load the exam.',
      );
    }
  }, [id]);

  useEffect(() => {
    if (user?.role === 'EXAMINER') void reload();
  }, [user, reload]);

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
        <Alert>Only trainers can build exams.</Alert>
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell wide>
        <Alert>{error}</Alert>
        <Link href="/exams/">Back to your exams</Link>
      </Shell>
    );
  }
  if (!exam) {
    return (
      <Shell wide>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }

  const locked = exam.status !== 'DRAFT';
  const tabs: [Tab, string][] = [
    ['questions', `Questions (${exam.questionCount})`],
    ['import', 'Import'],
    ['settings', 'Settings'],
    ['logo', 'Logo'],
    ['publish', locked ? 'Share' : 'Publish'],
    ...(exam.code && exam.status === 'PUBLISHED' ? ([['seats', 'Seats']] as [Tab, string][]) : []),
    ...(locked ? ([['results', 'Results']] as [Tab, string][]) : []),
  ];

  return (
    <Shell wide>
      <div className="topbar">
        <div>
          <h1 style={{ margin: 0 }}>{exam.title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            <StatusBadge status={exam.status} /> {exam.questionCount} questions · {exam.totalMarks}{' '}
            marks · {exam.durationMinutes} min
          </p>
        </div>
        <div className="toolbar">
          <Link className="btn btn-secondary btn-link" href="/exams/">
            All exams
          </Link>
          <Link className="btn btn-primary btn-link" href={`/exams/preview/?id=${exam.id}`}>
            Preview as student
          </Link>
          {!locked && (
            <Button
              variant="danger"
              onClick={async () => {
                if (!window.confirm('Delete this draft exam and all its questions?')) return;
                await api(`/exams/${exam.id}`, { method: 'DELETE' });
                window.location.href = '/exams/';
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {locked && (
        <Alert kind="info">
          This exam is {exam.status.replace(/_/g, ' ').toLowerCase()} and can no longer be edited.
        </Alert>
      )}

      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className="tab"
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="card">
        {tab === 'questions' && <QuestionsTab exam={exam} reload={reload} locked={locked} />}
        {tab === 'import' && <ImportTab exam={exam} reload={reload} locked={locked} />}
        {tab === 'settings' &&
          (locked ? (
            <Alert kind="info">Settings are locked.</Alert>
          ) : (
            <ExamSettingsForm
              initial={exam}
              submitLabel="Save settings"
              onSubmit={async (values) => {
                await api(`/exams/${exam.id}`, { method: 'PATCH', body: values });
                await reload();
              }}
            />
          ))}
        {tab === 'logo' && <LogoTab exam={exam} reload={reload} locked={locked} />}
        {tab === 'seats' && <SeatsPanel exam={exam} userName={user.name} userEmail={user.email} />}
        {tab === 'results' && <ResultsPanel exam={exam} reload={reload} />}
        {tab === 'publish' && (
          <PublishPanel exam={exam} userName={user.name} userEmail={user.email} reload={reload} />
        )}
      </section>
    </Shell>
  );
}

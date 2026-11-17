'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  CODE_LANGUAGES,
  type CodeLanguage,
  type PracticeFeedbackDto,
  type PracticeQuestionDto,
  type PracticeRoundDto,
  type PracticeSetDto,
  type PracticeSummaryDto,
} from '@assessiq/shared';
import {
  Alert,
  Button,
  PageHeader,
  Shell,
  StatusBadge,
  describeError,
  useQueryParam,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';

const letter = (i: number) => String.fromCharCode(65 + i);
const when = (iso: string) => new Date(iso).toLocaleString();
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

export default function PracticePage() {
  const { user, loading } = useRequireAuth();
  const examId = useQueryParam('exam');

  if (loading || !user) {
    return (
      <Shell wide>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }
  if (user.role !== 'STUDENT') {
    return (
      <Shell wide>
        <Alert>Practice sets are for students.</Alert>
      </Shell>
    );
  }
  return <Shell wide>{examId ? <PracticeSet examId={examId} /> : <PracticeList />}</Shell>;
}

// ---------------------------------------------------------------------- the list

function PracticeList() {
  const [items, setItems] = useState<PracticeSummaryDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<PracticeSummaryDto[]>('/practice')
      .then(setItems)
      .catch((e) => setError(describeError(e).message));
  }, []);

  return (
    <>
      <PageHeader title="Practice" subtitle="Practise the questions of exams you have taken">
        <Link className="btn btn-secondary btn-link" href="/dashboard/">
          Back to dashboard
        </Link>
      </PageHeader>
      {error && <Alert>{error}</Alert>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <Alert kind="info">
          A practice set opens here after an exam you took has closed. Practice never changes your
          official score.
        </Alert>
      )}
      <div className="stack">
        {items?.map((p) => (
          <section className="card" key={p.examId}>
            <div className="toolbar">
              <div>
                <strong>{p.title}</strong>
                <div className="muted">
                  {p.trainerName} · {p.questionCount} questions · open until {day(p.expiresAt)}
                </div>
              </div>
              <span className="spacer" />
              {p.rounds > 0 ? (
                <StatusBadge
                  status="LIVE"
                  label={`${p.rounds} round${p.rounds === 1 ? '' : 's'} · best ${p.bestPercent}%`}
                />
              ) : (
                <StatusBadge status="PUBLISHED" label="Not started" />
              )}
              <Link className="btn btn-primary btn-link" href={`/practice/?exam=${p.examId}`}>
                {p.rounds > 0 ? 'Practise again' : 'Start practising'}
              </Link>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------- one set

type Draft = { selected: number[]; text: string; language: CodeLanguage | null };

function PracticeSet({ examId }: { examId: string }) {
  const [set, setSet] = useState<PracticeSetDto | null>(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [feedback, setFeedback] = useState<Record<string, PracticeFeedbackDto>>({});
  const [round, setRound] = useState<PracticeRoundDto | null>(null);
  const [history, setHistory] = useState<PracticeRoundDto[]>([]);
  const [finishing, setFinishing] = useState(false);

  const loadHistory = () =>
    api<PracticeRoundDto[]>(`/practice/${examId}/rounds`)
      .then(setHistory)
      .catch(() => undefined);

  useEffect(() => {
    api<PracticeSetDto>(`/practice/${examId}`)
      .then((s) => {
        setSet(s);
        void loadHistory();
      })
      .catch((e) =>
        setError(e instanceof ApiError && e.status === 403 ? e.message : describeError(e).message),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  const draftOf = (q: PracticeQuestionDto): Draft =>
    drafts[q.id] ?? { selected: [], text: '', language: q.coding?.languages[0] ?? null };
  const setDraft = (q: PracticeQuestionDto, patch: Partial<Draft>) => {
    setDrafts((d) => ({ ...d, [q.id]: { ...draftOf(q), ...patch } }));
    // An edited answer needs a fresh check.
    setFeedback((f) => {
      if (!f[q.id]) return f;
      const rest = { ...f };
      delete rest[q.id];
      return rest;
    });
  };

  async function finish() {
    if (!set) return;
    setFinishing(true);
    setError('');
    try {
      const answers: Record<string, number[]> = {};
      for (const q of set.questions) {
        if (q.type === 'SINGLE' || q.type === 'MULTI') answers[q.id] = draftOf(q).selected;
      }
      setRound(
        await api<PracticeRoundDto>(`/practice/${examId}/rounds`, {
          method: 'POST',
          body: { answers },
        }),
      );
      await loadHistory();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setFinishing(false);
    }
  }

  function again() {
    setRound(null);
    setDrafts({});
    setFeedback({});
    window.scrollTo({ top: 0 });
  }

  if (!set) {
    return (
      <>
        {error ? <Alert kind="info">{error}</Alert> : <p className="muted">Loading…</p>}
        <p>
          <Link href="/dashboard/">Back to dashboard</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={set.title}
        subtitle={`Practice · open until ${day(set.expiresAt)} · does not affect your official result`}
      >
        <Link className="btn btn-secondary btn-link" href="/practice/">
          All practice sets
        </Link>
      </PageHeader>
      {error && <Alert>{error}</Alert>}

      {round && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h2 style={{ marginTop: 0 }}>
            Round score: {round.score} / {round.maxScore} ({round.percent}%)
          </h2>
          <p className="muted">
            {round.answered} of {round.scoredCount} choice questions answered. Written and coding
            questions are not scored; use their checks for feedback.
          </p>
          <Button onClick={again}>Start a new round</Button>
        </section>
      )}

      {set.questions.map((q) => (
        <QuestionCard
          key={q.id}
          examId={examId}
          q={q}
          draft={draftOf(q)}
          feedback={feedback[q.id]}
          onDraft={(p) => setDraft(q, p)}
          onFeedback={(f) => setFeedback((m) => ({ ...m, [q.id]: f }))}
        />
      ))}

      <div className="toolbar" style={{ margin: '16px 0' }}>
        <Button loading={finishing} onClick={finish}>
          Finish round and see my score
        </Button>
      </div>

      {history.length > 0 && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Your practice history</h2>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Score</th>
                <th>Answered</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.createdAt)}</td>
                  <td>
                    {r.score} / {r.maxScore} ({r.percent}%)
                  </td>
                  <td>
                    {r.answered} / {r.scoredCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function QuestionCard({
  examId,
  q,
  draft,
  feedback,
  onDraft,
  onFeedback,
}: {
  examId: string;
  q: PracticeQuestionDto;
  draft: Draft;
  feedback?: PracticeFeedbackDto;
  onDraft: (p: Partial<Draft>) => void;
  onFeedback: (f: PracticeFeedbackDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choice = q.type === 'SINGLE' || q.type === 'MULTI';

  async function check() {
    setBusy(true);
    setError('');
    try {
      onFeedback(
        await api<PracticeFeedbackDto>(`/practice/${examId}/questions/${q.id}/check`, {
          method: 'POST',
          body: choice
            ? { selected: draft.selected }
            : q.type === 'CODING'
              ? { text: draft.text, language: draft.language }
              : { text: draft.text },
        }),
      );
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 14 }}>
      <div className="toolbar">
        <strong>Question {q.number}</strong>
        <span className="spacer" />
        <span className="muted">{q.marks} marks</span>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{q.body}</p>

      {choice && (
        <div className="stack">
          {q.type === 'MULTI' && <small className="muted">Select all that apply.</small>}
          {q.options.map((o, i) => {
            const on = draft.selected.includes(i);
            const right = feedback?.correctOptions.includes(i);
            const cls = feedback ? (right ? 'correct' : on ? 'wrong' : '') : '';
            return (
              <label
                className={`check q-item ${cls ? `q-pick ${cls}` : ''}`}
                key={i}
                style={{ cursor: 'pointer' }}
              >
                <input
                  type={q.type === 'SINGLE' ? 'radio' : 'checkbox'}
                  name={q.id}
                  checked={on}
                  onChange={() =>
                    onDraft({
                      selected:
                        q.type === 'SINGLE'
                          ? [i]
                          : on
                            ? draft.selected.filter((x) => x !== i)
                            : [...draft.selected, i],
                    })
                  }
                />{' '}
                {letter(i)}. {o}
              </label>
            );
          })}
        </div>
      )}

      {q.type === 'SUBJECTIVE' && (
        <textarea
          value={draft.text}
          onChange={(e) => onDraft({ text: e.target.value })}
          placeholder="Write your answer here (optional), then check what a good answer covers"
          style={{ width: '100%', minHeight: 140, font: 'inherit', padding: 10 }}
          maxLength={20000}
        />
      )}

      {q.type === 'CODING' && q.coding && <CodeEditor q={q} draft={draft} onDraft={onDraft} />}

      <div className="toolbar" style={{ marginTop: 10 }}>
        <Button variant="secondary" loading={busy} onClick={check}>
          {q.type === 'CODING'
            ? 'Run all tests'
            : q.type === 'SUBJECTIVE'
              ? 'Show what a good answer covers'
              : 'Check answer'}
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {feedback && <Feedback f={feedback} />}
    </section>
  );
}

function CodeEditor({
  q,
  draft,
  onDraft,
}: {
  q: PracticeQuestionDto;
  draft: Draft;
  onDraft: (p: Partial<Draft>) => void;
}) {
  const spec = q.coding!;
  const language = draft.language ?? spec.languages[0];
  // Start with the starter code the first time a language is chosen.
  const text = draft.text || spec.starterCode[language] || '';
  return (
    <div className="stack">
      <div>
        <strong>Sample cases</strong>
        <div className="row" style={{ marginTop: 6 }}>
          {spec.samples.map((s, i) => (
            <div className="q-item" key={i}>
              <small className="muted">Input</small>
              <pre className="code-block">{s.input || '(empty)'}</pre>
              <small className="muted">Expected output</small>
              <pre className="code-block">{s.expectedOutput}</pre>
            </div>
          ))}
        </div>
        <small className="muted">
          {spec.hiddenCount > 0
            ? `${spec.hiddenCount} hidden test case${spec.hiddenCount === 1 ? '' : 's'} also run. `
            : ''}
          Limits: {spec.timeLimitMs / 1000}s per test, {spec.memoryMb} MB.
        </small>
      </div>
      <label className="check">
        Language
        <select
          value={language}
          onChange={(e) => {
            const next = e.target.value as CodeLanguage;
            onDraft({ language: next, text: spec.starterCode[next] ?? '' });
          }}
        >
          {spec.languages.map((l) => (
            <option key={l} value={l}>
              {CODE_LANGUAGES[l].label}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="code-area code-editor"
        value={text}
        onChange={(e) => onDraft({ text: e.target.value, language })}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        maxLength={50_000}
        aria-label="Your code"
      />
    </div>
  );
}

function Feedback({ f }: { f: PracticeFeedbackDto }) {
  return (
    <div className="stack" style={{ marginTop: 10 }}>
      {f.correct === true && (
        <Alert kind="success">
          {f.type === 'CODING' ? 'All tests passed.' : `Correct! +${f.marks} marks.`}
        </Alert>
      )}
      {f.correct === false && (
        <Alert>
          {f.type === 'CODING'
            ? 'Some tests failed.'
            : f.marks && f.marks > 0
              ? `Partly right: ${f.marks} of ${f.maxMarks} marks.`
              : 'Not quite.'}{' '}
          {f.correctOptions.length > 0 && (
            <>Correct answer: {f.correctOptions.map(letter).join(', ')}.</>
          )}
        </Alert>
      )}
      {f.guidance && (
        <Alert kind="info">
          <strong>A good answer covers:</strong> {f.guidance}
        </Alert>
      )}
      {f.type === 'SUBJECTIVE' && !f.guidance && !f.explanation && (
        <Alert kind="info">There is no model answer for this question.</Alert>
      )}
      {f.tests?.map((t, i) => (
        <div className="q-item" key={i}>
          <div className="toolbar">
            <strong>
              {t.hidden ? 'Hidden' : 'Sample'} test {i + 1}
            </strong>
            <StatusBadge
              status={t.passed ? 'LIVE' : 'SUSPENDED'}
              label={t.passed ? 'Passed' : t.status.replace(/_/g, ' ').toLowerCase()}
            />
            {t.timeMs !== null && <small className="muted">{t.timeMs} ms</small>}
          </div>
          {!t.hidden && !t.passed && (
            <div className="row" style={{ marginTop: 6 }}>
              <div>
                <small className="muted">Expected</small>
                <pre className="code-block">{t.expectedOutput}</pre>
              </div>
              <div>
                <small className="muted">Your output</small>
                <pre className="code-block">{t.actualOutput || '(nothing)'}</pre>
              </div>
            </div>
          )}
          {t.message && <pre className="code-block code-error">{t.message}</pre>}
        </div>
      ))}
      {f.explanation && (
        <p className="muted" style={{ margin: 0 }}>
          <strong>Explanation:</strong> {f.explanation}
        </p>
      )}
    </div>
  );
}

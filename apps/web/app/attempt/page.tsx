'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AttemptAnswerDto,
  AttemptDto,
  ProctorEventType,
  SaveAnswerInput,
} from '@assessiq/shared';
import { Alert, Button, useQueryParam } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';

type SaveState = 'saved' | 'saving' | 'error';

const END_TEXT: Record<string, string> = {
  SUBMITTED_BY_STUDENT: 'You submitted your exam.',
  TIME_UP: 'Time ran out, so your exam was submitted automatically.',
  STRIKES: 'Your exam was submitted automatically after 3 warnings for leaving the exam screen.',
};

function clock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const isAnswered = (a?: AttemptAnswerDto) => Boolean(a && (a.selected.length > 0 || a.text.trim()));

export default function AttemptPage() {
  const { user, loading } = useRequireAuth();
  const id = useQueryParam('id');
  const [attempt, setAttempt] = useState<AttemptDto | null>(null);
  const [answers, setAnswers] = useState<Record<string, AttemptAnswerDto>>({});
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [begun, setBegun] = useState(false);
  const [fullscreen, setFullscreen] = useState(true);
  const [warning, setWarning] = useState('');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const clockOffset = useRef(0);
  const pending = useRef<Record<string, SaveAnswerInput>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ended = useRef(false);

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    if (!id || user?.role !== 'STUDENT') return;
    api<AttemptDto>(`/attempts/${id}`)
      .then((a) => {
        clockOffset.current = new Date(a.serverTime).getTime() - Date.now();
        setAttempt(a);
        setAnswers(a.answers);
        ended.current = a.status !== 'IN_PROGRESS';
      })
      .catch((err) =>
        setFatal(
          err instanceof ApiError && err.status === 404
            ? 'This exam attempt was not found.'
            : 'Could not load the exam. Check your connection and refresh.',
        ),
      );
  }, [id, user]);

  const live = attempt?.status === 'IN_PROGRESS';

  // --------------------------------------------------------------- autosave
  const flush = useCallback(async () => {
    if (!attempt) return;
    const batch = pending.current;
    pending.current = {};
    const entries = Object.entries(batch);
    if (entries.length === 0) return;
    setSaveState('saving');
    let failed = false;
    for (const [qid, patch] of entries) {
      try {
        await api(`/attempts/${attempt.id}/answers/${qid}`, { method: 'PUT', body: patch });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // The attempt ended on the server (time up or strikes). Reload to show the result.
          window.location.reload();
          return;
        }
        failed = true;
        // Put it back so the next flush retries; newer edits win.
        pending.current[qid] = { ...patch, ...pending.current[qid] };
      }
    }
    setSaveState(failed ? 'error' : 'saved');
    if (failed) timer.current = setTimeout(() => void flush(), 3000);
  }, [attempt]);

  const change = useCallback(
    (qid: string, patch: SaveAnswerInput) => {
      setAnswers((prev) => {
        const cur = prev[qid] ?? { selected: [], text: '', flagged: false };
        return {
          ...prev,
          [qid]: {
            selected: patch.selected ?? cur.selected,
            text: patch.text ?? cur.text,
            flagged: patch.flagged ?? cur.flagged,
          },
        };
      });
      pending.current[qid] = { ...pending.current[qid], ...patch };
      setSaveState('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 500);
    },
    [flush],
  );

  // ----------------------------------------------------------------- submit
  const submit = useCallback(async () => {
    if (!attempt || ended.current) return;
    setSubmitting(true);
    try {
      if (timer.current) clearTimeout(timer.current);
      await flush();
      const done = await api<AttemptDto>(`/attempts/${attempt.id}/submit`, { method: 'POST' });
      ended.current = true;
      setAttempt(done);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } catch {
      setError('Could not submit. Check your connection and try again.');
    } finally {
      setSubmitting(false);
      setConfirmSubmit(false);
    }
  }, [attempt, flush]);

  // ------------------------------------------------------------------ timer
  useEffect(() => {
    if (!attempt || !live) return;
    const deadline = new Date(attempt.deadlineAt).getTime();
    const tick = () => {
      const left = Math.round((deadline - (Date.now() + clockOffset.current)) / 1000);
      setRemaining(left);
      if (left <= 0 && !ended.current) void submit();
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [attempt, live, submit]);

  // -------------------------------------------------------------- proctoring
  const report = useCallback(
    async (type: ProctorEventType) => {
      if (!attempt || ended.current) return;
      try {
        const res = await api<{ strikes: number; ended: boolean }>(
          `/attempts/${attempt.id}/events`,
          {
            method: 'POST',
            body: { type },
          },
        );
        if (res.ended) {
          window.location.reload();
          return;
        }
        setAttempt((a) => (a ? { ...a, strikes: res.strikes } : a));
        if (['TAB_HIDDEN', 'WINDOW_BLUR', 'FULLSCREEN_EXIT'].includes(type)) {
          setWarning(
            `Warning ${res.strikes} of ${attempt.maxStrikes}: stay on the exam screen. ${attempt.maxStrikes} warnings submit your exam automatically.`,
          );
        }
      } catch {
        // Offline: nothing to do; the next event will be reported.
      }
    },
    [attempt],
  );

  useEffect(() => {
    if (!live || !begun) return;
    const onVisibility = () => document.hidden && void report('TAB_HIDDEN');
    const onBlur = () => void report('WINDOW_BLUR');
    const onFullscreen = () => {
      const inFs = Boolean(document.fullscreenElement);
      setFullscreen(inFs);
      if (!inFs) void report('FULLSCREEN_EXIT');
    };
    const block = (type: ProctorEventType) => (e: Event) => {
      e.preventDefault();
      void report(type);
    };
    const onCopy = block('COPY');
    const onPaste = block('PASTE');
    const onMenu = block('CONTEXT_MENU');
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(k)) ||
        (e.ctrlKey && k === 'u')
      ) {
        e.preventDefault();
        void report('DEVTOOLS_KEY');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('contextmenu', onMenu);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('contextmenu', onMenu);
      document.removeEventListener('keydown', onKey);
    };
  }, [live, begun, report]);

  // Warn before closing the tab while answers are unsaved.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (live && (saveState !== 'saved' || begun)) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [live, saveState, begun]);

  function begin() {
    // Do not wait for the browser: some refuse or never answer, and the exam must still start.
    try {
      void document.documentElement.requestFullscreen()?.catch(() => undefined);
    } catch {
      // Fullscreen unsupported: the exam proceeds without it.
    }
    setBegun(true);
  }

  // ------------------------------------------------------------------ views
  if (loading || !user)
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  if (user.role !== 'STUDENT') {
    return (
      <main className="page">
        <Alert>Only students take exams.</Alert>
      </main>
    );
  }
  if (fatal) {
    return (
      <main className="page">
        <Alert>{fatal}</Alert>
        <Link href="/dashboard/">Back to dashboard</Link>
      </main>
    );
  }
  if (!attempt)
    return (
      <main className="page">
        <p className="muted">Loading exam…</p>
      </main>
    );

  if (!live) {
    return (
      <main className="page">
        <section className="card">
          <h1>Exam submitted</h1>
          <p>{END_TEXT[attempt.endReason ?? ''] ?? 'Your exam has been submitted.'}</p>
          <p className="muted">
            Your answers are saved. Results appear on your dashboard once your trainer publishes
            them.
          </p>
          <Link className="btn btn-primary btn-link" href="/dashboard/">
            Back to dashboard
          </Link>
        </section>
      </main>
    );
  }

  if (!begun) {
    return (
      <main className="page">
        <section className="card">
          <h1>{attempt.exam.title}</h1>
          <p className="muted">
            {attempt.questions.length} questions · {attempt.exam.durationMinutes} minutes · your
            timer is already running
          </p>
          {attempt.exam.instructions && (
            <p style={{ whiteSpace: 'pre-wrap' }}>{attempt.exam.instructions}</p>
          )}
          <Alert kind="info">
            The exam runs full screen. Leaving the screen, switching tabs or windows counts as a
            warning, and {attempt.maxStrikes} warnings submit your exam automatically. Copy, paste
            and right-click are disabled. You have {attempt.strikes} warning
            {attempt.strikes === 1 ? '' : 's'} so far.
          </Alert>
          <Button onClick={begin}>{attempt.questions.length ? 'Begin exam' : 'Continue'}</Button>
        </section>
      </main>
    );
  }

  const q = attempt.questions[current];
  const a = answers[q.id] ?? { selected: [], text: '', flagged: false };
  const answeredCount = attempt.questions.filter((x) => isAnswered(answers[x.id])).length;

  return (
    <main className="page page-wide" style={{ userSelect: 'none' }}>
      <div className="topbar">
        <strong>{attempt.exam.title}</strong>
        <div className="toolbar">
          <span className="muted">
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'error'
                ? 'Not saved, retrying…'
                : 'All saved'}
          </span>
          <span className="badge">
            Warnings {attempt.strikes}/{attempt.maxStrikes}
          </span>
          <span
            className="badge"
            style={{
              fontSize: '1rem',
              color: remaining !== null && remaining < 300 ? 'var(--danger)' : undefined,
            }}
            aria-live="off"
          >
            {remaining === null ? '--:--' : clock(remaining)}
          </span>
        </div>
      </div>

      {warning && (
        <Alert>
          {warning}{' '}
          <button className="btn btn-secondary btn-small" onClick={() => setWarning('')}>
            OK
          </button>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {!fullscreen && (
        <Alert>
          You left full screen.{' '}
          <Button
            small
            onClick={() => document.documentElement.requestFullscreen().catch(() => undefined)}
          >
            Return to full screen
          </Button>
        </Alert>
      )}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr) 220px' }}>
        <section className="card">
          <div className="toolbar">
            <strong>
              Question {q.number} of {attempt.questions.length}
            </strong>
            <span className="muted">
              {q.marks} marks{q.negativeMarks ? `, −${q.negativeMarks} if wrong` : ''}
            </span>
            <span className="spacer" />
            <Button
              variant={a.flagged ? 'primary' : 'secondary'}
              small
              onClick={() => change(q.id, { flagged: !a.flagged })}
            >
              {a.flagged ? 'Flagged for review' : 'Flag for review'}
            </Button>
          </div>
          <div className="q-body" style={{ whiteSpace: 'pre-wrap', margin: '12px 0' }}>
            {q.body}
          </div>

          {q.type === 'SUBJECTIVE' ? (
            <textarea
              value={a.text}
              onChange={(e) => change(q.id, { text: e.target.value })}
              placeholder="Type your answer here"
              style={{ width: '100%', minHeight: 220, font: 'inherit', padding: 10 }}
              maxLength={20000}
            />
          ) : (
            <div className="stack">
              {q.type === 'MULTI' && <small className="muted">Select all that apply.</small>}
              {q.options.map((o, i) => {
                const checked = a.selected.includes(o.id);
                return (
                  <label className="check q-item" key={o.id} style={{ cursor: 'pointer' }}>
                    <input
                      type={q.type === 'SINGLE' ? 'radio' : 'checkbox'}
                      name={q.id}
                      checked={checked}
                      onChange={() =>
                        change(q.id, {
                          selected:
                            q.type === 'SINGLE'
                              ? [o.id]
                              : checked
                                ? a.selected.filter((x) => x !== o.id)
                                : [...a.selected, o.id],
                        })
                      }
                    />{' '}
                    {String.fromCharCode(65 + i)}. {o.text}
                  </label>
                );
              })}
              {a.selected.length > 0 && q.type === 'SINGLE' && (
                <div>
                  <Button variant="secondary" small onClick={() => change(q.id, { selected: [] })}>
                    Clear answer
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="toolbar" style={{ marginTop: 16 }}>
            <Button
              variant="secondary"
              disabled={current === 0}
              onClick={() => setCurrent((c) => c - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={current === attempt.questions.length - 1}
              onClick={() => setCurrent((c) => c + 1)}
            >
              Next
            </Button>
            <span className="spacer" />
            <Button onClick={() => setConfirmSubmit(true)}>Submit exam</Button>
          </div>
        </section>

        <aside className="card" aria-label="Question navigator">
          <strong>Questions</strong>
          <p className="muted" style={{ margin: '4px 0 8px' }}>
            {answeredCount} of {attempt.questions.length} answered
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {attempt.questions.map((x, i) => {
              const ans = answers[x.id];
              const done = isAnswered(ans);
              return (
                <button
                  key={x.id}
                  className="btn btn-small"
                  aria-label={`Question ${x.number}${done ? ', answered' : ''}${ans?.flagged ? ', flagged' : ''}`}
                  aria-current={i === current}
                  onClick={() => setCurrent(i)}
                  style={{
                    padding: '6px 0',
                    border: `2px solid ${i === current ? 'var(--primary)' : 'var(--border)'}`,
                    background: done ? 'var(--primary)' : 'transparent',
                    color: done ? 'var(--primary-text)' : 'var(--text)',
                    outline: ans?.flagged ? '2px dashed var(--danger)' : undefined,
                  }}
                >
                  {x.number}
                </button>
              );
            })}
          </div>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Filled = answered. Dashed red = flagged.
          </p>
        </aside>
      </div>

      {confirmSubmit && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.6)',
            display: 'grid',
            placeItems: 'center',
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 420 }}>
            <h2 style={{ marginTop: 0 }}>Submit your exam?</h2>
            <p>
              You have answered {answeredCount} of {attempt.questions.length} questions
              {attempt.questions.some((x) => answers[x.id]?.flagged)
                ? ' and some are flagged for review'
                : ''}
              . You cannot change your answers after submitting.
            </p>
            <div className="toolbar">
              <Button loading={submitting} onClick={submit}>
                Yes, submit
              </Button>
              <Button variant="secondary" onClick={() => setConfirmSubmit(false)}>
                Keep working
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AutosaveQueue,
  type AttemptAnswerDto,
  type AttemptDto,
  type ProctorEventType,
  type SaveAnswerInput,
  type SendResult,
} from '@assessiq/shared';
import { CodeAnswer } from '../../components/code-answer';
import { Alert, Button, useQueryParam } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';

type SaveState = 'saved' | 'saving' | 'error';

const END_TEXT: Record<string, string> = {
  SUBMITTED_BY_STUDENT: 'You submitted your exam.',
  TIME_UP: 'Time ran out, so your exam was submitted automatically.',
  STRIKES:
    'Your exam was submitted automatically after too many warnings for leaving the exam screen.',
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
const blank = (): AttemptAnswerDto => ({ selected: [], text: '', language: null, flagged: false });

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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ended = useRef(false);
  const latest = useRef<Record<string, AttemptAnswerDto>>({});
  const unsentEvents = useRef<ProctorEventType[]>([]);
  const [unsaved, setUnsaved] = useState(0);

  // One queue per attempt: a single save in flight, rising sequence numbers, and a copy of
  // unsaved answers in localStorage so a refresh or crash while offline loses nothing.
  const queue = useMemo(() => {
    if (!attempt) return null;
    const key = `aiq-pending-${attempt.id}`;
    return new AutosaveQueue<AttemptAnswerDto>({
      storage: {
        get: () => window.localStorage.getItem(key),
        set: (v) => window.localStorage.setItem(key, v),
        remove: () => window.localStorage.removeItem(key),
      },
      send: async (qid, value, seq): Promise<SendResult> => {
        const body: SaveAnswerInput = {
          selected: value.selected,
          text: value.text,
          flagged: value.flagged,
          seq,
          ...(value.language ? { language: value.language as SaveAnswerInput['language'] } : {}),
        };
        try {
          await api(`/attempts/${attempt.id}/answers/${qid}`, { method: 'PUT', body });
          return 'ok';
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) return 'ended';
          if (err instanceof ApiError && err.code === 'DEVICE_MISMATCH') {
            setFatal(err.message);
            return 'fatal';
          }
          return 'retry';
        }
      },
    });
  }, [attempt?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    if (!id || user?.role !== 'STUDENT') return;
    api<AttemptDto>(`/attempts/${id}`)
      .then((a) => {
        clockOffset.current = new Date(a.serverTime).getTime() - Date.now();
        setAttempt(a);
        setAnswers(a.answers);
        latest.current = a.answers;
        ended.current = a.status !== 'IN_PROGRESS';
      })
      .catch((err) =>
        setFatal(
          err instanceof ApiError && err.code === 'DEVICE_MISMATCH'
            ? err.message
            : err instanceof ApiError && err.status === 404
              ? 'This exam attempt was not found.'
              : 'Could not load the exam. Check your connection and refresh.',
        ),
      );
  }, [id, user]);

  const live = attempt?.status === 'IN_PROGRESS';

  // --------------------------------------------------------------- autosave
  const flush = useCallback(async () => {
    if (!queue) return 'saved' as const;
    setSaveState('saving');
    const res = await queue.flush();
    setUnsaved(queue.size);
    if (res === 'ended') {
      window.location.reload();
    } else if (res === 'failed') {
      setSaveState('error');
      timer.current = setTimeout(() => void flush(), 3000);
    } else if (res === 'saved') {
      setSaveState('saved');
    }
    return res;
  }, [queue]);

  // Brings back answers typed while offline (before a refresh or crash), then saves them.
  useEffect(() => {
    if (!queue || !live) return;
    const restored = queue.restore();
    if (Object.keys(restored).length > 0) {
      latest.current = { ...latest.current, ...restored };
      setAnswers(latest.current);
      setUnsaved(queue.size);
      void flush();
    }
  }, [queue, live, flush]);

  const change = useCallback(
    (qid: string, patch: SaveAnswerInput) => {
      if (!queue) return;
      const cur = latest.current[qid] ?? blank();
      const next: AttemptAnswerDto = {
        selected: patch.selected ?? cur.selected,
        text: patch.text ?? cur.text,
        language: patch.language ?? cur.language,
        flagged: patch.flagged ?? cur.flagged,
      };
      latest.current = { ...latest.current, [qid]: next };
      setAnswers(latest.current);
      // The whole answer is queued each time, so a late older save can never drop a newer field.
      queue.set(qid, next);
      setUnsaved(queue.size);
      setSaveState('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 500);
    },
    [queue, flush],
  );

  // ----------------------------------------------------------------- submit
  const submit = useCallback(
    async (timeUp = false) => {
      if (!attempt || ended.current) return;
      setSubmitting(true);
      try {
        if (timer.current) clearTimeout(timer.current);
        const saved = queue ? await queue.flushWithRetries(3, 1000) : 'saved';
        setUnsaved(queue?.size ?? 0);
        if (saved === 'ended') {
          window.location.reload();
          return;
        }
        if (saved !== 'saved' && !timeUp) {
          // Do not submit with answers the server does not have yet. The timer keeps running and
          // the server submits at the deadline anyway.
          setSaveState('error');
          setError(
            `Your last ${queue?.size ?? 0} answer(s) are not saved yet, so the exam was not submitted. Check your connection; we keep retrying.`,
          );
          timer.current = setTimeout(() => void flush(), 3000);
          return;
        }
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
    },
    [attempt, flush, queue],
  );

  // ------------------------------------------------------------------ timer
  useEffect(() => {
    if (!attempt || !live) return;
    const deadline = new Date(attempt.deadlineAt).getTime();
    const tick = () => {
      const left = Math.round((deadline - (Date.now() + clockOffset.current)) / 1000);
      setRemaining(left);
      if (left <= 0 && !ended.current) void submit(true);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [attempt, live, submit]);

  // -------------------------------------------------------------- proctoring
  const report = useCallback(
    async (type: ProctorEventType) => {
      if (!attempt || ended.current) return;
      const key = `aiq-events-${attempt.id}`;
      const keep = () => {
        try {
          if (unsentEvents.current.length === 0) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, JSON.stringify(unsentEvents.current));
        } catch {
          // Storage unavailable: events only live in memory.
        }
      };
      if (unsentEvents.current.length === 0) {
        try {
          const stored = window.localStorage.getItem(key);
          if (stored) unsentEvents.current = JSON.parse(stored);
        } catch {
          // ignore
        }
      }
      unsentEvents.current.push(type);
      if (unsentEvents.current.length > 200) unsentEvents.current.shift();
      keep();
      const batch = unsentEvents.current.slice(0, 50);
      try {
        const res = await api<{ strikes: number; ended: boolean }>(
          batch.length === 1
            ? `/attempts/${attempt.id}/events`
            : `/attempts/${attempt.id}/events/batch`,
          {
            method: 'POST',
            body:
              batch.length === 1 ? { type: batch[0] } : { events: batch.map((t) => ({ type: t })) },
          },
        );
        unsentEvents.current = unsentEvents.current.slice(batch.length);
        keep();
        if (res.ended) {
          window.location.reload();
          return;
        }
        setAttempt((a) => (a ? { ...a, strikes: res.strikes } : a));
        if (
          attempt.strikePolicy !== 'OFF' &&
          ['TAB_HIDDEN', 'WINDOW_BLUR', 'FULLSCREEN_EXIT'].includes(type)
        ) {
          setWarning(
            attempt.strikePolicy === 'AUTO_SUBMIT'
              ? `Warning ${res.strikes} of ${attempt.maxStrikes}: stay on the exam screen. ${attempt.maxStrikes} warnings submit your exam automatically.`
              : `Warning ${res.strikes}: please stay on the exam screen. Your trainer can see this.`,
          );
        }
      } catch {
        // Offline: the event stays queued and goes out in a batch with the next one.
      }
    },
    [attempt],
  );

  useEffect(() => {
    if (!live || !begun) return;
    // A blur shorter than this (a notification, a password-manager popup) is not reported.
    let pendingAway: ReturnType<typeof setTimeout> | null = null;
    const away = (type: ProctorEventType) => {
      if (pendingAway) return;
      pendingAway = setTimeout(() => {
        pendingAway = null;
        if (document.hidden || !document.hasFocus()) void report(type);
      }, 1500);
    };
    const back = () => {
      if (pendingAway) clearTimeout(pendingAway);
      pendingAway = null;
    };
    const onVisibility = () => (document.hidden ? away('TAB_HIDDEN') : back());
    const onBlur = () => away('WINDOW_BLUR');
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
    window.addEventListener('focus', back);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('contextmenu', onMenu);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', back);
      back();
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
      if (live && (saveState !== 'saved' || unsaved > 0 || begun)) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [live, saveState, unsaved, begun]);

  function begin() {
    // Do not wait for the browser: some refuse or never answer, and the exam must still start.
    if (typeof document.documentElement.requestFullscreen === 'function') {
      try {
        void document.documentElement.requestFullscreen()?.catch(() => undefined);
      } catch {
        // Refused: the exam proceeds without it.
      }
    } else {
      // iOS Safari and some tablets have no full screen. Note it for the trainer, never penalise.
      void report('FULLSCREEN_UNSUPPORTED');
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
          {remaining !== null && remaining < attempt.exam.durationMinutes * 60 - 60 && (
            <Alert kind="info">
              You have {Math.max(0, Math.ceil(remaining / 60))} minutes left, less than the full{' '}
              {attempt.exam.durationMinutes}, because the exam closes at{' '}
              {new Date(attempt.deadlineAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </Alert>
          )}
          {attempt.exam.instructions && (
            <p style={{ whiteSpace: 'pre-wrap' }}>{attempt.exam.instructions}</p>
          )}
          <Alert kind="info">
            {attempt.strikePolicy === 'AUTO_SUBMIT' &&
              `The exam runs full screen. Leaving the screen, switching tabs or windows counts as a warning, and ${attempt.maxStrikes} warnings submit your exam automatically. You have ${attempt.strikes} warning${attempt.strikes === 1 ? '' : 's'} so far.`}
            {attempt.strikePolicy === 'WARN' &&
              `The exam runs full screen. Leaving the screen or switching tabs gives you a warning and your trainer sees the count, but it will not submit your exam. You have ${attempt.strikes} warning${attempt.strikes === 1 ? '' : 's'} so far.`}
            {attempt.strikePolicy === 'OFF' &&
              'Your trainer is told if you leave the exam screen or switch tabs. There are no warnings and nothing is submitted for you.'}{' '}
            Copy, paste and right-click are disabled. Very short interruptions, like a notification,
            are ignored.
          </Alert>
          <Button onClick={begin}>{attempt.questions.length ? 'Begin exam' : 'Continue'}</Button>
        </section>
      </main>
    );
  }

  const q = attempt.questions[current];
  const a = answers[q.id] ?? blank();
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
          {attempt.strikePolicy !== 'OFF' && (
            <span className="badge">
              Warnings {attempt.strikes}
              {attempt.strikePolicy === 'AUTO_SUBMIT' ? `/${attempt.maxStrikes}` : ''}
            </span>
          )}
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

          {q.type === 'CODING' && q.coding ? (
            <CodeAnswer
              key={q.id}
              attemptId={attempt.id}
              question={q}
              answer={a}
              onChange={(patch) => change(q.id, patch)}
            />
          ) : q.type === 'SUBJECTIVE' ? (
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
              <Button loading={submitting} onClick={() => void submit()}>
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

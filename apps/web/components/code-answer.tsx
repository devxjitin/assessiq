'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CODE_LANGUAGES,
  type AttemptAnswerDto,
  type AttemptQuestionDto,
  type CodeLanguage,
  type RunResultDto,
  type SampleRunResult,
  type SaveAnswerInput,
  type TestStatus,
} from '@assessiq/shared';
import { api } from '../lib/api';
import { Alert, Button, StatusBadge, describeError } from './ui';

const STATUS_LABEL: Record<TestStatus, string> = {
  PASSED: 'Passed',
  WRONG_ANSWER: 'Wrong answer',
  COMPILE_ERROR: 'Compile error',
  RUNTIME_ERROR: 'Runtime error',
  TIME_LIMIT: 'Time limit exceeded',
  MEMORY_LIMIT: 'Memory limit exceeded',
  ERROR: 'Error',
};

export function TestStatusBadge({ status }: { status: TestStatus }) {
  return (
    <StatusBadge status={status === 'PASSED' ? 'LIVE' : 'SUSPENDED'} label={STATUS_LABEL[status]} />
  );
}

/** Code editor for a coding question: language, source, and "Run on samples". */
export function CodeAnswer({
  attemptId,
  question,
  answer,
  onChange,
  disabled,
}: {
  attemptId: string;
  question: AttemptQuestionDto;
  answer: AttemptAnswerDto;
  onChange: (patch: SaveAnswerInput) => void;
  disabled?: boolean;
}) {
  const spec = question.coding!;
  const language = (answer.language as CodeLanguage | null) ?? spec.languages[0];
  // The server keeps one source per question; keep a draft per language so switching is not lossy.
  const drafts = useRef<Partial<Record<CodeLanguage, string>>>({});
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<RunResultDto | null>(null);
  const [error, setError] = useState('');

  const source = answer.text;

  // First visit: put the starter code in the editor (and remember the language).
  useEffect(() => {
    if (!disabled && answer.text === '' && spec.starterCode[language]) {
      onChange({ text: spec.starterCode[language], language });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchLanguage(next: CodeLanguage) {
    drafts.current[language] = source;
    onChange({
      language: next,
      text: drafts.current[next] ?? spec.starterCode[next] ?? '',
    });
    setRun(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Tab inserts spaces instead of leaving the editor.
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    const next = el.value.slice(0, s) + '    ' + el.value.slice(end);
    onChange({ text: next, language });
    requestAnimationFrame(() => el.setSelectionRange(s + 4, s + 4));
  }

  async function runSamples() {
    setError('');
    setRunning(true);
    try {
      setRun(
        await api<RunResultDto>(`/attempts/${attemptId}/questions/${question.id}/run`, {
          method: 'POST',
          body: { language, source },
        }),
      );
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setRunning(false);
    }
  }

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
            ? `${spec.hiddenCount} more hidden test case${spec.hiddenCount === 1 ? '' : 's'} will be used for grading. `
            : ''}
          Limits: {spec.timeLimitMs / 1000}s per test, {spec.memoryMb} MB.
        </small>
      </div>

      <div className="toolbar">
        <label className="check">
          Language
          <select
            value={language}
            disabled={disabled}
            onChange={(e) => switchLanguage(e.target.value as CodeLanguage)}
          >
            {spec.languages.map((l) => (
              <option key={l} value={l}>
                {CODE_LANGUAGES[l].label}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <Button
          type="button"
          variant="secondary"
          loading={running}
          onClick={runSamples}
          disabled={disabled}
        >
          Run on samples
        </Button>
      </div>

      <textarea
        className="code-area code-editor"
        value={source}
        onChange={(e) => onChange({ text: e.target.value, language })}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        maxLength={50_000}
        aria-label="Your code"
      />

      {error && <Alert>{error}</Alert>}
      {run && <RunResults run={run} />}
    </div>
  );
}

function RunResults({ run }: { run: RunResultDto }) {
  return (
    <div className="stack">
      {run.results.map((r: SampleRunResult, i) => (
        <div className="q-item" key={i}>
          <div className="toolbar">
            <strong>Sample {i + 1}</strong>
            <TestStatusBadge status={r.status} />
            {r.timeMs !== null && <small className="muted">{r.timeMs} ms</small>}
          </div>
          {r.status !== 'PASSED' && (
            <div className="row" style={{ marginTop: 6 }}>
              <div>
                <small className="muted">Expected</small>
                <pre className="code-block">{r.expectedOutput}</pre>
              </div>
              <div>
                <small className="muted">Your output</small>
                <pre className="code-block">{r.actualOutput || '(nothing)'}</pre>
              </div>
            </div>
          )}
          {r.message && <pre className="code-block code-error">{r.message}</pre>}
        </div>
      ))}
      <small className="muted">
        {run.runsLeft} run{run.runsLeft === 1 ? '' : 's'} left for this question. Passing the
        samples does not guarantee the hidden cases pass.
      </small>
    </div>
  );
}

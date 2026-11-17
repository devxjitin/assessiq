'use client';

import {
  CODE_LANGUAGES,
  CODE_LANGUAGE_KEYS,
  CODING_LIMITS,
  type CodeLanguage,
  type CodingSpec,
} from '@assessiq/shared';
import { Button } from './ui';

export interface CodingDraft {
  languages: CodeLanguage[];
  starter: Partial<Record<CodeLanguage, string>>;
  timeLimitMs: string;
  memoryMb: string;
  tests: { input: string; expectedOutput: string; hidden: boolean; weight: string }[];
}

export function emptyCodingDraft(): CodingDraft {
  return {
    languages: ['python'],
    starter: {},
    timeLimitMs: '2000',
    memoryMb: '256',
    tests: [{ input: '', expectedOutput: '', hidden: false, weight: '1' }],
  };
}

export function draftFromSpec(spec: CodingSpec): CodingDraft {
  return {
    languages: spec.languages,
    starter: spec.starterCode,
    timeLimitMs: String(spec.timeLimitMs),
    memoryMb: String(spec.memoryMb),
    tests: spec.testCases.map((t) => ({
      input: t.input,
      expectedOutput: t.expectedOutput,
      hidden: t.hidden,
      weight: String(t.weight),
    })),
  };
}

export function draftToInput(d: CodingDraft) {
  return {
    languages: d.languages,
    starterCode: Object.fromEntries(
      d.languages.filter((l) => d.starter[l]?.trim()).map((l) => [l, d.starter[l]]),
    ),
    timeLimitMs: Number(d.timeLimitMs),
    memoryMb: Number(d.memoryMb),
    testCases: d.tests.map((t) => ({
      input: t.input,
      expectedOutput: t.expectedOutput,
      hidden: t.hidden,
      weight: Number(t.weight),
    })),
  };
}

export function CodingFields({
  draft,
  onChange,
  error,
}: {
  draft: CodingDraft;
  onChange: (next: CodingDraft) => void;
  error?: string;
}) {
  const set = (patch: Partial<CodingDraft>) => onChange({ ...draft, ...patch });
  const setTest = (i: number, patch: Partial<CodingDraft['tests'][number]>) =>
    set({ tests: draft.tests.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) });

  function toggleLanguage(l: CodeLanguage) {
    set({
      languages: draft.languages.includes(l)
        ? draft.languages.filter((x) => x !== l)
        : [...draft.languages, l],
    });
  }

  return (
    <div className="stack">
      <div className="field">
        <span>Languages students may use</span>
        <div className="toolbar">
          {CODE_LANGUAGE_KEYS.map((l) => (
            <label className="check" key={l}>
              <input
                type="checkbox"
                checked={draft.languages.includes(l)}
                onChange={() => toggleLanguage(l)}
              />
              {CODE_LANGUAGES[l].label}
            </label>
          ))}
        </div>
      </div>

      <div className="row">
        <label className="field">
          <span>Time limit per test (ms)</span>
          <input
            type="number"
            min={CODING_LIMITS.MIN_TIME_MS}
            max={CODING_LIMITS.MAX_TIME_MS}
            step={100}
            value={draft.timeLimitMs}
            onChange={(e) => set({ timeLimitMs: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Memory limit (MB)</span>
          <input
            type="number"
            min={CODING_LIMITS.MIN_MEMORY_MB}
            max={CODING_LIMITS.MAX_MEMORY_MB}
            value={draft.memoryMb}
            onChange={(e) => set({ memoryMb: e.target.value })}
          />
        </label>
      </div>

      {draft.languages.map((l) => (
        <label className="field" key={l}>
          <span>Starter code for {CODE_LANGUAGES[l].label} (optional)</span>
          <textarea
            className="code-area"
            value={draft.starter[l] ?? ''}
            onChange={(e) => set({ starter: { ...draft.starter, [l]: e.target.value } })}
            spellCheck={false}
            maxLength={CODING_LIMITS.MAX_SOURCE_CHARS}
          />
        </label>
      ))}

      <div className="field">
        <span>Test cases</span>
        <small className="muted">
          Sample cases are shown to students, who can run their code on them. Hidden cases are used
          only for grading. Marks are split by weight: a student who passes cases worth 3 of 4 total
          weight gets three quarters of the marks.
        </small>
        {draft.tests.map((t, i) => (
          <div className="q-item" key={i} style={{ marginTop: 8 }}>
            <div className="toolbar">
              <strong>Test {i + 1}</strong>
              <label className="check">
                <input
                  type="checkbox"
                  checked={t.hidden}
                  onChange={(e) => setTest(i, { hidden: e.target.checked })}
                />
                Hidden
              </label>
              <label className="check">
                Weight
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={t.weight}
                  onChange={(e) => setTest(i, { weight: e.target.value })}
                  style={{ width: 72 }}
                />
              </label>
              <span className="spacer" />
              <Button
                type="button"
                variant="secondary"
                small
                disabled={draft.tests.length <= 1}
                onClick={() => set({ tests: draft.tests.filter((_, idx) => idx !== i) })}
              >
                Remove
              </Button>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="field">
                <span>Input (stdin)</span>
                <textarea
                  className="code-area"
                  value={t.input}
                  onChange={(e) => setTest(i, { input: e.target.value })}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>Expected output</span>
                <textarea
                  className="code-area"
                  value={t.expectedOutput}
                  onChange={(e) => setTest(i, { expectedOutput: e.target.value })}
                  spellCheck={false}
                />
              </label>
            </div>
          </div>
        ))}
        {draft.tests.length < CODING_LIMITS.MAX_TEST_CASES && (
          <div style={{ marginTop: 8 }}>
            <Button
              type="button"
              variant="secondary"
              small
              onClick={() =>
                set({
                  tests: [
                    ...draft.tests,
                    { input: '', expectedOutput: '', hidden: true, weight: '1' },
                  ],
                })
              }
            >
              Add test case
            </Button>
          </div>
        )}
        <small className="muted">
          Output is compared ignoring spaces at the end of each line and blank lines at the end.
        </small>
        {error && <small className="error-text">{error}</small>}
      </div>
    </div>
  );
}

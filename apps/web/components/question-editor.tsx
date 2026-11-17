'use client';

import { useState } from 'react';
import { questionInputSchema, type ExamQuestionDto } from '@assessiq/shared';
import {
  CodingFields,
  draftFromSpec,
  draftToInput,
  emptyCodingDraft,
  type CodingDraft,
} from './coding-fields';
import { Alert, Button, FieldErrors, describeError, validate } from './ui';

type Kind = 'SINGLE' | 'MULTI' | 'SUBJECTIVE' | 'CODING';

export function QuestionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ExamQuestionDto;
  onSave: (input: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [type, setType] = useState<Kind>((initial?.type as Kind) ?? 'SINGLE');
  const [body, setBody] = useState(initial?.body ?? '');
  const [options, setOptions] = useState<string[]>(
    initial?.options.length ? initial.options : ['', '', '', ''],
  );
  const [correct, setCorrect] = useState<number[]>(initial?.correctOptions ?? []);
  const [marks, setMarks] = useState(String(initial?.marks ?? 4));
  const [negative, setNegative] = useState(String(initial?.negativeMarks ?? 0));
  const [partial, setPartial] = useState(initial?.partialCredit ?? false);
  const [explanation, setExplanation] = useState(initial?.explanation ?? '');
  const [rubric, setRubric] = useState(initial?.rubric ?? '');
  const [coding, setCoding] = useState<CodingDraft>(
    initial?.coding ? draftFromSpec(initial.coding) : emptyCodingDraft(),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const isChoice = type === 'SINGLE' || type === 'MULTI';

  function changeType(next: Kind) {
    setType(next);
    // A single-answer question keeps at most one correct option.
    if (next === 'SINGLE') setCorrect((c) => c.slice(0, 1));
  }

  function toggleCorrect(i: number) {
    if (type === 'SINGLE') setCorrect([i]);
    else setCorrect((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]));
  }

  function removeOption(i: number) {
    setOptions((o) => o.filter((_, idx) => idx !== i));
    // Re-point the correct answers at the shifted option indexes.
    setCorrect((c) => c.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const common = {
      type,
      body,
      marks: Number(marks),
      negativeMarks: Number(negative),
      explanation: explanation || null,
    };
    const candidate =
      type === 'CODING'
        ? { ...common, coding: draftToInput(coding) }
        : isChoice
          ? {
              ...common,
              options: options.map((o) => o.trim()),
              correctOptions: correct,
              partialCredit: type === 'MULTI' && partial,
            }
          : { ...common, rubric: rubric || null };
    const result = validate(questionInputSchema, candidate);
    if (!result.ok) {
      setErrors(result.errors);
      setMessage('');
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSave(result.data);
    } catch (err) {
      const d = describeError(err);
      setMessage(d.message);
      setErrors(d.fields);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="q-item" noValidate>
      {message && <Alert>{message}</Alert>}
      <label className="field">
        <span>Question type</span>
        <select value={type} onChange={(e) => changeType(e.target.value as Kind)}>
          <option value="SINGLE">Multiple choice, one correct answer</option>
          <option value="MULTI">Multiple choice, several correct answers</option>
          <option value="SUBJECTIVE">Subjective (written answer)</option>
          <option value="CODING">Coding (auto-graded with test cases)</option>
        </select>
      </label>
      <label className="field">
        <span>Question</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={5000}
          aria-invalid={errors.body ? true : undefined}
        />
        {errors.body && <small className="error-text">{errors.body}</small>}
      </label>

      {isChoice && (
        <div className="field">
          <span>Options — tick the correct {type === 'SINGLE' ? 'one' : 'ones'}</span>
          {options.map((opt, i) => (
            <div className="opt-row" key={i} style={{ marginTop: 6 }}>
              <input
                type={type === 'SINGLE' ? 'radio' : 'checkbox'}
                name="correct"
                checked={correct.includes(i)}
                onChange={() => toggleCorrect(i)}
                aria-label={`Option ${String.fromCharCode(65 + i)} is correct`}
              />
              <input
                value={opt}
                onChange={(e) =>
                  setOptions((o) => o.map((x, idx) => (idx === i ? e.target.value : x)))
                }
                placeholder={`Option ${String.fromCharCode(65 + i)}`}
                maxLength={1000}
              />
              <Button
                type="button"
                variant="secondary"
                small
                disabled={options.length <= 2}
                onClick={() => removeOption(i)}
              >
                Remove
              </Button>
            </div>
          ))}
          {errors.options && <small className="error-text">{errors.options}</small>}
          {errors.correctOptions && <small className="error-text">{errors.correctOptions}</small>}
          {type === 'MULTI' && (
            <label className="check" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={partial}
                onChange={(e) => setPartial(e.target.checked)}
              />
              Give partial marks when only some correct options are picked (and none wrong)
            </label>
          )}
          {options.length < 6 && (
            <div style={{ marginTop: 8 }}>
              <Button
                type="button"
                variant="secondary"
                small
                onClick={() => setOptions((o) => [...o, ''])}
              >
                Add option
              </Button>
            </div>
          )}
        </div>
      )}

      {type === 'CODING' && (
        <CodingFields draft={coding} onChange={setCoding} error={errors.coding} />
      )}

      {type === 'SUBJECTIVE' && (
        <label className="field">
          <span>Marking guidance for you (students never see this)</span>
          <textarea value={rubric} onChange={(e) => setRubric(e.target.value)} maxLength={3000} />
        </label>
      )}

      <div className="row">
        <label className="field">
          <span>Marks</span>
          <input
            type="number"
            min={0}
            max={100}
            step="0.25"
            value={marks}
            onChange={(e) => setMarks(e.target.value)}
          />
          {errors.marks && <small className="error-text">{errors.marks}</small>}
        </label>
        <label className="field">
          <span>Negative marks</span>
          <input
            type="number"
            min={0}
            max={100}
            step="0.25"
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
          />
          {errors.negativeMarks && <small className="error-text">{errors.negativeMarks}</small>}
        </label>
      </div>
      <label className="field">
        <span>Explanation (shown after results, optional)</span>
        <textarea
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          maxLength={3000}
        />
      </label>
      <div className="toolbar">
        <Button type="submit" loading={busy}>
          Save question
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

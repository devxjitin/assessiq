'use client';

import { useState } from 'react';
import { createExamSchema, updateExamSchema, type ExamDetailDto } from '@assessiq/shared';
import { Alert, Button, Field, FieldErrors, describeError, validate } from './ui';

/** ISO string -> value for <input type="datetime-local"> in the viewer's time zone. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const toIso = (local: string): string | null => {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? local : d.toISOString(); // bad input fails validation
};

/** Blank number inputs become NaN so the schema reports them instead of treating them as 0. */
const toNumber = (v: FormDataEntryValue | null): number =>
  v === null || String(v).trim() === '' ? Number.NaN : Number(v);

// Editing an existing exam keeps the original rules (no "already in the past" check on a
// running or finished exam); every setting is still required in the form.
const updateExamFormSchema = updateExamSchema;

export interface ExamSettingsValues {
  title: string;
  description: string | null;
  instructions: string | null;
  durationMinutes: number;
  startsAt: string | null;
  endsAt: string | null;
  passPercent: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  certificatesEnabled?: boolean;
}

export function ExamSettingsForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: ExamDetailDto;
  submitLabel: string;
  onSubmit: (values: ExamSettingsValues) => Promise<void>;
}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const candidate = {
      title: String(f.get('title') ?? ''),
      description: String(f.get('description') ?? '') || null,
      instructions: String(f.get('instructions') ?? '') || null,
      durationMinutes: toNumber(f.get('durationMinutes')),
      startsAt: toIso(String(f.get('startsAt') ?? '')),
      endsAt: toIso(String(f.get('endsAt') ?? '')),
      passPercent: toNumber(f.get('passPercent')),
      shuffleQuestions: f.get('shuffleQuestions') === 'on',
      shuffleOptions: f.get('shuffleOptions') === 'on',
      certificatesEnabled: f.get('certificatesEnabled') === 'on',
    };
    const result = validate(initial ? updateExamFormSchema : createExamSchema, candidate);
    setSaved(false);
    // Early hints only. The API still accepts any window on a draft and enforces it at publish.
    const hints: FieldErrors = {};
    if (result.ok && !initial) {
      if (!candidate.startsAt) hints.startsAt = 'Choose when the exam opens';
      if (!candidate.endsAt) hints.endsAt = 'Choose when the exam closes';
    }
    if (result.ok && !initial && candidate.endsAt && !hints.endsAt) {
      const end = new Date(candidate.endsAt).getTime();
      const start = candidate.startsAt ? new Date(candidate.startsAt).getTime() : null;
      if (end <= Date.now()) hints.endsAt = 'The closing time is already in the past';
      else if (start !== null && end - start < candidate.durationMinutes * 60_000)
        hints.endsAt = 'The window between opening and closing is shorter than the exam duration';
    }
    if (!result.ok || Object.keys(hints).length) {
      const errs = result.ok ? hints : result.errors;
      setErrors(errs);
      setMessage('Please fix the highlighted fields.');
      const first = Object.keys(errs)[0];
      if (first) e.currentTarget.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    if (!result.ok) return; // narrowed for TypeScript; handled above
    setErrors({});
    setMessage('');
    setBusy(true);
    try {
      // The certificate choice is only made at creation.
      const { certificatesEnabled: _ignored, ...rest } = result.data as ExamSettingsValues;
      await onSubmit(
        (initial
          ? rest
          : { ...rest, certificatesEnabled: candidate.certificatesEnabled }) as ExamSettingsValues,
      );
      setSaved(true);
    } catch (err) {
      const d = describeError(err);
      setMessage(d.message);
      setErrors(d.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="form-layout"
      onSubmit={submit}
      onChange={(e) => {
        const name = (e.target as unknown as HTMLInputElement).name;
        if (name && errors[name]) setErrors(({ [name]: _gone, ...rest }) => rest);
      }}
      noValidate
    >
      {(message || saved) && (
        <div className="form-full">
          {message && <Alert>{message}</Alert>}
          {saved && <Alert kind="success">Saved.</Alert>}
        </div>
      )}

      <section className="form-section form-full">
        <h3>Basics</h3>
        <p className="card-sub">What students see before and during the exam.</p>
        <Field
          label="Exam title"
          name="title"
          defaultValue={initial?.title}
          error={errors.title}
          maxLength={150}
        />
        <div className="field-row field-row-2">
          <label className="field">
            <span>Description (optional)</span>
            <textarea
              name="description"
              defaultValue={initial?.description ?? ''}
              maxLength={2000}
            />
            {errors.description && <small className="error-text">{errors.description}</small>}
          </label>
          <label className="field">
            <span>Instructions shown to students (optional)</span>
            <textarea
              name="instructions"
              defaultValue={initial?.instructions ?? ''}
              maxLength={4000}
            />
            {errors.instructions && <small className="error-text">{errors.instructions}</small>}
          </label>
        </div>
      </section>

      <section className="form-section">
        <h3>Schedule</h3>
        <p className="card-sub">Both dates are required.</p>
        <div className="field-row field-row-2">
          <Field
            label="Opens at"
            name="startsAt"
            type="datetime-local"
            defaultValue={toLocalInput(initial?.startsAt)}
            error={errors.startsAt}
          />
          <Field
            label="Closes at"
            name="endsAt"
            type="datetime-local"
            defaultValue={toLocalInput(initial?.endsAt)}
            error={errors.endsAt}
          />
        </div>
      </section>

      <section className="form-section">
        <h3>Limits and grading</h3>
        <p className="card-sub">How long it runs and who can sit it.</p>
        <div className="field-row field-row-3">
          <Field
            label="Duration (min)"
            name="durationMinutes"
            type="number"
            min={5}
            max={360}
            defaultValue={initial?.durationMinutes ?? 60}
            error={errors.durationMinutes}
          />
          <Field
            label="Pass mark (%)"
            name="passPercent"
            type="number"
            min={0}
            max={100}
            step="0.5"
            defaultValue={initial?.passPercent ?? 40}
            error={errors.passPercent}
          />
        </div>
      </section>

      <section className="form-section">
        <h3>Shuffling</h3>
        <p className="card-sub">Randomise what each student sees.</p>
        <label className="check toggle">
          <input
            type="checkbox"
            name="shuffleQuestions"
            defaultChecked={initial?.shuffleQuestions ?? true}
          />
          Shuffle question order for each student
        </label>
        <label className="check toggle">
          <input
            type="checkbox"
            name="shuffleOptions"
            defaultChecked={initial?.shuffleOptions ?? true}
          />
          Shuffle answer options
        </label>
      </section>

      {!initial && (
        <section className="form-section">
          <h3>Certificates</h3>
          <p className="card-sub">
            Decide now: students get a certificate when you publish results. You cannot change this
            later. If you turn it off, there is no certificate design step.
          </p>
          <label className="check toggle">
            <input type="checkbox" name="certificatesEnabled" defaultChecked />
            Give certificates for this exam
          </label>
        </section>
      )}

      <div className="form-full form-actions">
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

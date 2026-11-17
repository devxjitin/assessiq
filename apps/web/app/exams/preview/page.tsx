'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ExamPreviewDto } from '@assessiq/shared';
import { Alert, Shell, useQueryParam } from '../../../components/ui';
import { api } from '../../../lib/api';
import { useRequireAuth } from '../../../lib/auth';

/** Shows the exam the way a student will see it. Nothing here can be submitted. */
export default function PreviewPage() {
  const { user, loading } = useRequireAuth();
  const id = useQueryParam('id');
  const [exam, setExam] = useState<ExamPreviewDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id || user?.role !== 'EXAMINER') return;
    api<ExamPreviewDto>(`/exams/${id}/preview`)
      .then(setExam)
      .catch(() => setError('Could not load the preview.'));
  }, [id, user]);

  if (loading || !user) {
    return (
      <Shell>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }
  if (user.role !== 'EXAMINER') {
    return (
      <Shell>
        <Alert>Only trainers can preview exams.</Alert>
      </Shell>
    );
  }

  return (
    <Shell>
      <Alert kind="info">
        Preview only. This is what students will see; answers are not saved.
      </Alert>
      {error && <Alert>{error}</Alert>}
      {exam && (
        <div className="stack" style={{ marginTop: 16 }}>
          <section className="card">
            <h1>{exam.title}</h1>
            {exam.description && <p>{exam.description}</p>}
            <p className="muted">
              {exam.questions.length} questions · {exam.totalMarks} marks · {exam.durationMinutes}{' '}
              minutes · pass mark {exam.passPercent}%
            </p>
            {exam.instructions && <p style={{ whiteSpace: 'pre-wrap' }}>{exam.instructions}</p>}
          </section>
          {exam.questions.map((q) => (
            <section className="card" key={q.id}>
              <div className="toolbar">
                <strong>Question {q.position}</strong>
                <span className="muted">
                  {q.marks} marks{q.negativeMarks ? `, −${q.negativeMarks} if wrong` : ''}
                </span>
              </div>
              <div className="q-body" style={{ whiteSpace: 'pre-wrap' }}>
                {q.body}
              </div>
              {q.type === 'CODING' && q.coding ? (
                <div className="stack">
                  <small className="muted">
                    Students write code in {q.coding.languages.join(', ')} and can run it on{' '}
                    {q.coding.samples.length} sample case(s); {q.coding.hiddenCount} hidden case(s)
                    are used for grading.
                  </small>
                  {q.coding.samples.map((s, i) => (
                    <div className="q-item" key={i}>
                      <small className="muted">Sample input</small>
                      <pre className="code-block">{s.input || '(empty)'}</pre>
                      <small className="muted">Expected output</small>
                      <pre className="code-block">{s.expectedOutput}</pre>
                    </div>
                  ))}
                </div>
              ) : q.type === 'SUBJECTIVE' ? (
                <textarea
                  disabled
                  placeholder="Students type their answer here"
                  style={{ width: '100%', minHeight: 100 }}
                />
              ) : (
                <div className="stack">
                  {q.type === 'MULTI' && <small className="muted">Select all that apply.</small>}
                  {q.options.map((o, i) => (
                    <label className="check q-item" key={i}>
                      <input type={q.type === 'SINGLE' ? 'radio' : 'checkbox'} disabled />{' '}
                      {String.fromCharCode(65 + i)}. {o}
                    </label>
                  ))}
                </div>
              )}
            </section>
          ))}
          <Link href={`/exams/edit/?id=${exam.id}`}>Back to editing</Link>
        </div>
      )}
    </Shell>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ExamSummaryDto } from '@assessiq/shared';
import { Alert, PageHeader, Shell, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { useRequireAuth } from '../../lib/auth';

export default function ExamsPage() {
  const { user, loading } = useRequireAuth();
  const [exams, setExams] = useState<ExamSummaryDto[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user?.role !== 'EXAMINER') return;
    api<ExamSummaryDto[]>('/exams')
      .then(setExams)
      .catch(() => setError('Could not load your exams.'));
  }, [user]);

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

  return (
    <Shell wide>
      <PageHeader
        title="My exams"
        subtitle="Build exams, add questions and share them with students."
      >
        <Link className="btn btn-primary btn-link" href="/exams/new/">
          New exam
        </Link>
      </PageHeader>
      {error && <Alert>{error}</Alert>}
      <section className="card">
        {exams === null && !error && <p className="muted">Loading…</p>}
        {exams?.length === 0 && (
          <div className="empty">
            <strong>No exams yet</strong>
            Create one to start adding questions.
          </div>
        )}
        {exams && exams.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Questions</th>
                  <th>Total marks</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {exams.map((e) => (
                  <tr key={e.id}>
                    <td>{e.title}</td>
                    <td>
                      <StatusBadge status={e.status} />
                    </td>
                    <td>{e.questionCount}</td>
                    <td>{e.totalMarks}</td>
                    <td>{e.durationMinutes} min</td>
                    <td>
                      <Link
                        className="btn btn-secondary btn-small btn-link"
                        href={`/exams/edit/?id=${e.id}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

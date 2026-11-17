'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ExamDetailDto } from '@assessiq/shared';
import { ExamSettingsForm } from '../../../components/exam-settings-form';
import { Alert, Shell } from '../../../components/ui';
import { api } from '../../../lib/api';
import { useRequireAuth } from '../../../lib/auth';

export default function NewExamPage() {
  const { user, loading } = useRequireAuth();
  const router = useRouter();

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
        <Alert>Only trainers can build exams.</Alert>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="card">
        <h1>New exam</h1>
        <p className="muted">
          Set the basics now. You add questions next, and can change everything until you publish.
        </p>
        <ExamSettingsForm
          submitLabel="Create exam"
          onSubmit={async (values) => {
            const exam = await api<ExamDetailDto>('/exams', { method: 'POST', body: values });
            router.push(`/exams/edit/?id=${exam.id}`);
          }}
        />
        <p className="links">
          <Link href="/exams/">Back to your exams</Link>
        </p>
      </section>
    </Shell>
  );
}

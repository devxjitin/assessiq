'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ExamDetailDto } from '@assessiq/shared';
import { ExamSettingsForm } from '../../../components/exam-settings-form';
import { Alert, PageHeader, Shell } from '../../../components/ui';
import { api } from '../../../lib/api';
import { useRequireAuth } from '../../../lib/auth';

export default function NewExamPage() {
  const { user, loading } = useRequireAuth();
  const router = useRouter();

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
        title="New exam"
        subtitle="Set the basics now. You add questions next, and can change everything until you publish."
      >
        <Link className="btn btn-secondary btn-link" href="/exams/">
          Back to your exams
        </Link>
      </PageHeader>
      <ExamSettingsForm
        submitLabel="Create exam"
        onSubmit={async (values) => {
          const exam = await api<ExamDetailDto>('/exams', { method: 'POST', body: values });
          router.push(`/exams/edit/?id=${exam.id}`);
        }}
      />
    </Shell>
  );
}

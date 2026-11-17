'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { EnrollmentDto, ExamSummaryDto } from '@assessiq/shared';
import { Alert, Button, PageHeader, Shell, StatCard, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { StudentExams, enrollmentState } from '../../components/student-exams';
import { useRequireAuth } from '../../lib/auth';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'STUDENT' | 'EXAMINER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED';
  emailVerifiedAt: string | null;
  createdAt: string;
}

function AdminUsers({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api<{ total: number; users: AdminUser[] }>('/admin/users?pageSize=50');
      setUsers(data.users);
      setTotal(data.total);
    } catch {
      setError('Could not load users.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(user: AdminUser) {
    const status = user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    if (
      status === 'SUSPENDED' &&
      !window.confirm(`Suspend ${user.email}? They will be signed out immediately.`)
    )
      return;
    try {
      await api(`/admin/users/${user.id}/status`, { method: 'PATCH', body: { status } });
      await load();
    } catch {
      setError('Could not update the user.');
    }
  }

  return (
    <>
      <div className="stats">
        <StatCard label="Users" value={total} note="registered accounts" icon="users" highlight />
        <StatCard
          label="Active"
          value={users.filter((u) => u.status === 'ACTIVE').length}
          note="can sign in"
          icon="check"
        />
        <StatCard
          label="Suspended"
          value={users.filter((u) => u.status === 'SUSPENDED').length}
          note="signed out"
          icon="shield"
        />
      </div>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Users</h2>
        {error && <Alert>{error}</Alert>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>
                    <span className="badge">
                      {u.role === 'EXAMINER' ? 'trainer' : u.role.toLowerCase()}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={u.status} />
                  </td>
                  <td>
                    {u.id !== currentUserId && (
                      <Button
                        variant={u.status === 'ACTIVE' ? 'danger' : 'secondary'}
                        onClick={() => toggle(u)}
                      >
                        {u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function StudentHome() {
  const [items, setItems] = useState<EnrollmentDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<EnrollmentDto[]>('/me/enrollments')
      .then(setItems)
      .catch(() => setError('Could not load your exams.'));
  }, []);
  const states = (items ?? []).map(enrollmentState);
  const count = (...k: string[]) => states.filter((s) => k.includes(s)).length;
  return (
    <>
      <div className="stats">
        <StatCard label="Joined" value={items?.length ?? '–'} note="exams" icon="book" highlight />
        <StatCard
          label="Ready or upcoming"
          value={items ? count('READY', 'UPCOMING') : '–'}
          note="not started yet"
          icon="clock"
        />
        <StatCard
          label="In progress"
          value={items ? count('IN_PROGRESS') : '–'}
          note="resume any time"
          icon="edit"
        />
        <StatCard
          label="Submitted"
          value={items ? count('SUBMITTED') : '–'}
          note="exams completed"
          icon="check"
        />
      </div>
      <div className="two-col">
        <StudentExams items={items} loadError={error} />
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Quick actions</h2>
          <p className="card-sub">Have an exam code?</p>
          <Link className="btn btn-primary btn-link" href="/join/">
            Join an exam
          </Link>
        </section>
      </div>
    </>
  );
}

function TrainerHome() {
  const [exams, setExams] = useState<ExamSummaryDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<ExamSummaryDto[]>('/exams')
      .then(setExams)
      .catch(() => setError('Could not load your exams.'));
  }, []);
  const list = exams ?? [];
  return (
    <>
      <div className="stats">
        <StatCard
          label="Exams"
          value={exams ? list.length : '–'}
          note="created"
          icon="exams"
          highlight
        />
        <StatCard
          label="Published"
          value={exams ? list.filter((e) => e.status !== 'DRAFT').length : '–'}
          note="open for students"
          icon="check"
        />
        <StatCard
          label="Drafts"
          value={exams ? list.filter((e) => e.status === 'DRAFT').length : '–'}
          note="not published yet"
          icon="edit"
        />
        <StatCard
          label="Questions"
          value={exams ? list.reduce((n, e) => n + e.questionCount, 0) : '–'}
          note="across all exams"
          icon="book"
        />
      </div>
      <div className="two-col">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Recent exams</h2>
          <p className="card-sub">Your latest work.</p>
          {error && <Alert>{error}</Alert>}
          {exams === null && !error && <p className="muted">Loading…</p>}
          {exams?.length === 0 && (
            <div className="empty">
              <strong>No exams yet</strong>
              Create an exam, add questions, then publish it to get a code to share.
            </div>
          )}
          {list.slice(0, 5).map((e) => (
            <div className="list-row" key={e.id}>
              <div>
                <strong>{e.title}</strong>
                <div className="muted">
                  {e.questionCount} questions · {e.durationMinutes} min
                </div>
              </div>
              <span className="spacer" />
              <StatusBadge status={e.status} />
              <Link
                className="btn btn-secondary btn-small btn-link"
                href={`/exams/edit/?id=${e.id}`}
              >
                Open
              </Link>
            </div>
          ))}
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Quick actions</h2>
          <p className="card-sub">Build and share exams.</p>
          <div className="stack">
            <Link className="btn btn-primary btn-link" href="/exams/new/">
              New exam
            </Link>
            <div>
              <Link className="btn btn-secondary btn-link" href="/exams/">
                All exams
              </Link>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

export default function DashboardPage() {
  const { user, loading } = useRequireAuth();

  if (loading || !user) {
    return (
      <Shell wide>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }

  const first = user.name.split(' ')[0];
  const subtitle =
    user.role === 'STUDENT'
      ? 'Here is an overview of your exams.'
      : user.role === 'EXAMINER'
        ? 'Here is an overview of your exams.'
        : 'Here is an overview of the platform.';

  return (
    <Shell wide>
      <PageHeader title={`Welcome back, ${first}!`} subtitle={subtitle} />
      {user.role === 'STUDENT' && <StudentHome />}
      {user.role === 'EXAMINER' && <TrainerHome />}
      {user.role === 'ADMIN' && <AdminUsers currentUserId={user.id} />}
    </Shell>
  );
}

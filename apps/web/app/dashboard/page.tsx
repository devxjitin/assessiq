'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Shell } from '../../components/ui';
import { api } from '../../lib/api';
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
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Users ({total})</h2>
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
                  <span className="badge">{u.role}</span>
                </td>
                <td>{u.status}</td>
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
  );
}

export default function DashboardPage() {
  const { user, loading, logout } = useRequireAuth();

  if (loading || !user) {
    return (
      <Shell wide>
        <p className="muted">Loading…</p>
      </Shell>
    );
  }

  return (
    <Shell wide>
      <div className="topbar">
        <h1 style={{ margin: 0 }}>Hello, {user.name.split(' ')[0]}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="badge">{user.role === 'EXAMINER' ? 'TRAINER' : user.role}</span>
          <Link className="btn btn-secondary btn-link" href="/profile/">
            Profile
          </Link>
          <Button
            variant="secondary"
            onClick={() => logout().then(() => (window.location.href = '/login/'))}
          >
            Sign out
          </Button>
        </div>
      </div>

      {user.role === 'STUDENT' && (
        <div className="grid">
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Join an exam</h2>
            <p className="muted">Enter an exam code from your trainer. Available soon.</p>
          </section>
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Results and certificates</h2>
            <p className="muted">Your results and certificates will appear here.</p>
          </section>
        </div>
      )}

      {user.role === 'EXAMINER' && (
        <div className="grid">
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Your exams</h2>
            <p className="muted">Create and manage exams. Available soon.</p>
          </section>
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Earnings</h2>
            <p className="muted">Your share of student fees will appear here.</p>
          </section>
        </div>
      )}

      {user.role === 'ADMIN' && <AdminUsers currentUserId={user.id} />}
    </Shell>
  );
}

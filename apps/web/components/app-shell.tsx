'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { Icon, type IconName } from './icons';

type Theme = 'light' | 'dark';

/** Brand mark + wordmark. */
export function Brand({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand">
      <span className="brand-mark">A</span>
      {!compact && (
        <span className="brand-text">
          <b>
            Assess<span>IQ</span>
          </b>
          <small>by NandiVex</small>
        </span>
      )}
    </Link>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('aiq-theme', next);
    } catch {
      // storage blocked: the choice just lasts for this visit
    }
  }

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
    >
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
    </button>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

function navFor(role: string): NavItem[] {
  const home: NavItem = { href: '/dashboard/', label: 'Home', icon: 'home' };
  const profile: NavItem = { href: '/profile/', label: 'Profile', icon: 'user' };
  if (role === 'STUDENT') {
    return [home, { href: '/join/', label: 'Join an exam', icon: 'join' }, profile];
  }
  if (role === 'EXAMINER') {
    return [home, { href: '/exams/', label: 'My exams', icon: 'exams' }, profile];
  }
  return [home, profile];
}

const CRUMBS: Record<string, string> = {
  dashboard: 'Home',
  exams: 'My exams',
  new: 'New exam',
  edit: 'Edit exam',
  preview: 'Preview',
  join: 'Join an exam',
  profile: 'Profile',
};

const ROLE_LABEL: Record<string, string> = {
  STUDENT: 'Student portal',
  EXAMINER: 'Trainer portal',
  ADMIN: 'Admin portal',
};

export function AppShell({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  const { user, logout } = useAuth();
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const items = user ? navFor(user.role) : [];
  const segments = pathname.split('/').filter(Boolean);
  const crumbs = segments.map((s) => CRUMBS[s] ?? s);
  const initial = (user?.name ?? '?').trim().charAt(0).toUpperCase();

  return (
    <div className={`app${collapsed ? ' app-collapsed' : ''}${open ? ' app-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-head">
          <Brand />
          {user && <div className="sidebar-sub">{ROLE_LABEL[user.role] ?? ''}</div>}
        </div>
        <nav className="nav">
          {items.map((item) => {
            const active =
              pathname === item.href.slice(0, -1) ||
              pathname === item.href ||
              (item.href !== '/dashboard/' && pathname.startsWith(item.href.slice(0, -1) + '/'));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        {user && (
          <div className="sidebar-foot">
            <div className="user-chip">
              <span className="avatar">{initial}</span>
              <span className="user-meta">
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </span>
            </div>
            <button
              type="button"
              className="nav-item nav-button"
              onClick={() => logout().then(() => (window.location.href = '/login/'))}
            >
              <Icon name="logout" />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}

      <div className="app-main">
        <header className="appbar">
          <button
            type="button"
            className="icon-btn"
            aria-label="Toggle navigation"
            onClick={() => {
              if (window.matchMedia('(max-width: 900px)').matches) setOpen((v) => !v);
              else setCollapsed((v) => !v);
            }}
          >
            <Icon name="panel" />
          </button>
          <nav className="crumbs" aria-label="Breadcrumb">
            <span>AssessIQ</span>
            {crumbs.map((c, i) => (
              <span key={i} className={i === crumbs.length - 1 ? 'crumb-current' : undefined}>
                <Icon name="chevron" size={14} />
                {c}
              </span>
            ))}
          </nav>
          <span className="spacer" />
          <ThemeToggle />
        </header>
        <main className={narrow ? 'content content-narrow' : 'content'}>{children}</main>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, useApi } from './lib/api';
import { Banner } from './components/ui';
import { Dashboard } from './pages/Dashboard';
import { TasksPage } from './pages/Tasks';
import { SocialPage } from './pages/Social';
import { SeoPage } from './pages/Seo';
import { BudgetPage } from './pages/Budget';
import { BusinessPage } from './pages/Business';
import { SettingsPage } from './pages/Settings';

type User = { id: number; email: string; name: string };
type AuthStatus = { needsSetup: boolean; user: User | null };

const NAV = [
  { group: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: '◈', end: true }] },
  {
    group: 'Do the work',
    items: [
      { to: '/tasks', label: 'Tasks', icon: '☑' },
      { to: '/social', label: 'Social', icon: '◇' },
      { to: '/seo', label: 'SEO & AEO', icon: '◎' },
    ],
  },
  {
    group: 'Run the business',
    items: [
      { to: '/budget', label: 'Budget', icon: '▤' },
      { to: '/business', label: 'Business', icon: '◫' },
    ],
  },
];

export function App() {
  const { data, loading, reload } = useApi<AuthStatus>('/auth/status');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (data) setUser(data.user);
  }, [data]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
    void reload();
  }, [reload]);

  if (loading && !data) {
    return <div className="auth-shell"><span className="muted">Loading Helm…</span></div>;
  }

  if (!user) {
    return <AuthScreen needsSetup={!!data?.needsSetup} onAuthed={(u) => setUser(u)} />;
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">H</span>
          Helm
        </div>
        {NAV.map((section) => (
          <React.Fragment key={section.group}>
            <div className="nav-group">{section.group}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={(item as any).end}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </React.Fragment>
        ))}
        <div className="spacer" />
        <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon" aria-hidden="true">⚙</span>
          Settings
        </NavLink>
        <button className="nav-item" onClick={logout} style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}>
          <span className="nav-icon" aria-hidden="true">⏻</span>
          Sign out
        </button>
      </nav>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/social" element={<SocialPage />} />
          <Route path="/seo" element={<SeoPage />} />
          <Route path="/budget" element={<BudgetPage />} />
          <Route path="/business" element={<BusinessPage />} />
          <Route path="/settings" element={<SettingsPage user={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function AuthScreen({ needsSetup, onAuthed }: { needsSetup: boolean; onAuthed: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const path = needsSetup ? '/auth/setup' : '/auth/login';
      const result = await api.post<{ user: User }>(path, { email, password, name });
      onAuthed(result.user);
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card stack" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 6 }}>
          <span className="brand-mark" aria-hidden="true">H</span>
          Helm
        </div>
        <h1 style={{ fontSize: 19 }}>{needsSetup ? 'Create your account' : 'Sign in'}</h1>
        <p className="small muted" style={{ marginTop: -4 }}>
          {needsSetup
            ? 'Helm is single-user. This is the only account it will ever have.'
            : 'Your all-in-one business workspace.'}
        </p>

        <Banner tone="error">{error}</Banner>

        {needsSetup && (
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="field">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={needsSetup ? 8 : undefined}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
          />
        </label>

        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Working…' : needsSetup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

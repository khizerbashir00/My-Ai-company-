import { useQuery } from '@tanstack/react-query';
import { CheckSquare, LayoutDashboard, LogOut, Menu, Network, Settings, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLiveUpdates } from '../lib/live';
import type { Metrics } from '../lib/types';
import { cx } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/organization', label: 'Organization', icon: Network },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** Built in later phases. Listed so the roadmap is visible, never clickable. */
const LATER = [
  { label: 'Leads', phase: 3 },
  { label: 'Approvals', phase: 5 },
  { label: 'Campaigns', phase: 5 },
  { label: 'Reports', phase: 5 },
];

export function Layout() {
  const { user, logout } = useAuth();
  const live = useLiveUpdates(Boolean(user));
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setOpen(false);
  }

  // Small badge on Tasks: work that is waiting on the CEO or has failed.
  const metrics = useQuery({ queryKey: ['metrics', 'nav'], queryFn: () => api.get<Metrics>('/dashboard/metrics'), staleTime: 30_000 });
  const attention = metrics.data
    ? (metrics.data.tasks.byStatus.find((s) => s.status === 'AWAITING_APPROVAL')?.count ?? 0) + metrics.data.tasks.failed
    : 0;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 pb-6 pt-5">
        <img src="/favicon.svg" alt="" className="size-7" />
        <div className="leading-tight">
          <p className="font-semibold text-ink">HQ</p>
          <p className="text-[13px] text-ink-3">Your AI company</p>
        </div>
      </div>
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
                isActive ? 'bg-brand-wash text-brand-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
              )
            }
          >
            <Icon className="size-4" aria-hidden />
            <span className="flex-1">{label}</span>
            {label === 'Tasks' && attention > 0 && (
              <span className="num rounded-full bg-st-waiting-wash px-1.5 text-[12px] font-semibold text-st-waiting" title="Awaiting approval or failed">
                {attention}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="mt-6 px-6">
        <p className="mb-1.5 text-[13px] text-ink-3">Coming in later phases</p>
        <ul className="space-y-1 text-sm text-ink-3">
          {LATER.map((l) => (
            <li key={l.label} className="flex justify-between">
              <span>{l.label}</span>
              <span className="num text-[12px]">Phase {l.phase}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto border-t border-rule px-5 py-4">
        <div className="mb-3 flex items-center gap-2 text-[13px] text-ink-3" aria-live="polite">
          <span
            aria-hidden
            className={cx('size-2 rounded-full', live === 'live' ? 'bg-st-running' : live === 'connecting' ? 'bg-st-waiting' : 'bg-st-failed')}
          />
          {live === 'live' ? 'Live updates on' : live === 'connecting' ? 'Connecting…' : 'Live updates off'}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium text-ink">{user?.name}</p>
            <p className="truncate text-[13px] text-ink-3">{user?.role === 'CEO' ? 'Chief executive' : user?.role === 'ADMIN' ? 'Admin' : 'Viewer'}</p>
          </div>
          <button onClick={() => void logout()} className="rounded-md p-2 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Sign out" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-dvh border-r border-rule bg-panel lg:block">{sidebar}</aside>

      <div className="flex items-center justify-between border-b border-rule bg-panel px-4 py-3 lg:hidden">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="font-semibold">HQ</span>
        </div>
        <button onClick={() => setOpen(true)} className="rounded-md p-2 hover:bg-sunken" aria-label="Open menu">
          <Menu className="size-5" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[272px] bg-panel shadow-xl">
            <button onClick={() => setOpen(false)} className="absolute right-3 top-4 rounded-md p-2 hover:bg-sunken" aria-label="Close menu">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main className="min-w-0 px-4 py-6 sm:px-8 lg:py-8">
        <div className="mx-auto max-w-[1240px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

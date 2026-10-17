import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Link } from 'react-router';
import { Empty, ErrorNote, Loading, PageHeader, Section, cx } from '../components/ui';
import { api, qs } from '../lib/api';
import { timeAgo } from '../lib/format';

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationPage {
  items: NotificationRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['notifications', 'all'],
    queryFn: () => api.get<NotificationPage>(`/notifications${qs({ page: 1, pageSize: 50 })}`),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notifications-unread'] });
    },
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notifications-unread'] });
    },
  });

  const unread = list.data?.items.filter((n) => !n.readAt).length ?? 0;

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Alerts for approvals, replies, failed tasks, and reports. Duplicates are suppressed."
        actions={
          unread > 0 ? (
            <button
              type="button"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              className="rounded-md border border-rule-strong bg-panel px-3 py-1.5 text-sm font-medium text-ink hover:bg-sunken"
            >
              Mark all read
            </button>
          ) : null
        }
      />

      {list.isPending ? (
        <Loading label="Loading notifications" />
      ) : list.isError ? (
        <ErrorNote error={list.error} />
      ) : list.data.items.length === 0 ? (
        <Empty title="No notifications yet">
          You’ll see approval requests, positive replies, demo requests, and report-ready alerts here.
        </Empty>
      ) : (
        <Section title={`${list.data.total} total`} aside={<span className="num text-sm text-ink-3">{unread} unread</span>}>
          <ul className="divide-y divide-rule">
            {list.data.items.map((n) => {
              const inner = (
                <>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken">
                    <Bell className={cx('size-4', n.readAt ? 'text-ink-3' : 'text-brand')} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cx('block text-sm', n.readAt ? 'text-ink-2' : 'font-semibold text-ink')}>{n.title}</span>
                    {n.body ? <span className="mt-0.5 block text-[13px] text-ink-3">{n.body}</span> : null}
                    <span className="mt-1 block text-[12px] text-ink-3">
                      {n.type.replace(/_/g, ' ')} · {timeAgo(n.createdAt)}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={n.id}>
                  {n.link ? (
                    <Link
                      to={n.link}
                      onClick={() => {
                        if (!n.readAt) markRead.mutate(n.id);
                      }}
                      className={cx('flex items-start gap-3 px-4 py-3 hover:bg-sunken', !n.readAt && 'bg-brand-wash/40')}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (!n.readAt) markRead.mutate(n.id);
                      }}
                      className={cx('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-sunken', !n.readAt && 'bg-brand-wash/40')}
                    >
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </>
  );
}

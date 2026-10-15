import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useId } from 'react';
import { STATUS_LABEL } from '../lib/format';
import type { TaskStatus } from '../lib/types';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-ink border border-transparent',
  secondary: 'bg-panel text-ink border border-rule-strong hover:border-ink-3',
  quiet: 'text-ink-2 hover:text-ink hover:bg-sunken border border-transparent',
  danger: 'bg-panel text-st-failed border border-rule-strong hover:border-st-failed',
};

export function Button({
  variant = 'secondary',
  busy,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
    >
      {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  QUEUED: 'text-st-queued',
  RUNNING: 'text-st-running',
  AWAITING_APPROVAL: 'text-st-waiting bg-st-waiting-wash',
  COMPLETED: 'text-st-done',
  FAILED: 'text-st-failed bg-st-failed-wash',
  CANCELLED: 'text-st-cancelled',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[13px] font-medium', STATUS_STYLE[status])}>
      <span
        aria-hidden
        className={cx('size-2 rounded-full bg-current', status === 'RUNNING' && 'motion-safe:animate-pulse', status === 'CANCELLED' && 'opacity-60')}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="text-[13px] text-ink-3">{hint}</p>}
      {error && <p className="text-[13px] text-st-failed">{error}</p>}
    </div>
  );
}

/** Full width unless the caller passes its own width class. */
const width = (className?: string) => (className && /(^|\s)w-/.test(className) ? '' : 'w-full');

const control =
  'rounded-md border border-rule-strong bg-panel px-3 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} {...rest} className={cx(control, width(className), 'h-9', className)} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(control, width(className), 'h-9 pr-8', className)}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(control, width(className), 'py-2 leading-relaxed', className)} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-[68ch] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-rule bg-panel', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-ink-3">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <p role="alert" className={cx('rounded-md bg-st-failed-wash px-3 py-2 text-sm text-st-failed', className)}>
      {message}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-[52ch] text-sm text-ink-3">{children}</div>}
    </div>
  );
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-3 text-sm text-ink-2">
      <span className="num">
        {total} {total === 1 ? 'task' : 'tasks'}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="quiet" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="num">
          Page {page} of {totalPages}
        </span>
        <Button variant="quiet" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

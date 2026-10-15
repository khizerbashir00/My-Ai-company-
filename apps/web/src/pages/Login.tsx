import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button, ErrorNote, Field, Input } from '../components/ui';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="hidden flex-col justify-between bg-brand p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8 rounded-md ring-1 ring-white/30" />
          <span className="text-lg font-semibold">HQ</span>
        </div>
        <OrgSketch />
        <p className="max-w-[40ch] text-[17px] leading-relaxed text-white/85">
          Your AI managers find and qualify clients and plan marketing. You take the meetings, close the deals and build the software.
        </p>
      </div>

      <div className="flex items-center justify-center px-6 py-12">
        <form onSubmit={onSubmit} className="w-full max-w-[360px] space-y-5" noValidate>
          <div>
            <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Sign in to HQ</h1>
            <p className="mt-1 text-ink-2">Use the CEO account created during setup.</p>
          </div>
          <Field label="Email">
            {(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
          </Field>
          <Field label="Password">
            {(id) => (
              <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" variant="primary" busy={busy} className="w-full" disabled={!email || !password}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}

/** The company at a glance: you, one general manager, two departments. */
function OrgSketch() {
  return (
    <svg viewBox="0 0 360 220" className="w-full max-w-[420px]" role="img" aria-label="CEO, AI general manager, Sales and Marketing departments">
      <g fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5">
        <path d="M180 46v30M180 106v20M90 126h180M90 126v24M270 126v24" />
        <path d="M60 180v14M90 180v14M120 180v14M240 180v14M270 180v14M300 180v14" strokeOpacity="0.3" />
      </g>
      <g fontFamily="inherit" fontSize="13" textAnchor="middle">
        <rect x="140" y="16" width="80" height="30" rx="6" fill="white" />
        <text x="180" y="36" fill="#0F6E6B" fontWeight="600">
          You
        </text>
        <rect x="112" y="76" width="136" height="30" rx="6" fill="none" stroke="white" strokeOpacity="0.8" />
        <text x="180" y="96" fill="white">
          General manager
        </text>
        <rect x="40" y="150" width="100" height="30" rx="6" fill="none" stroke="white" strokeOpacity="0.8" />
        <text x="90" y="170" fill="white">
          Sales
        </text>
        <rect x="220" y="150" width="100" height="30" rx="6" fill="none" stroke="white" strokeOpacity="0.8" />
        <text x="270" y="170" fill="white">
          Marketing
        </text>
      </g>
      <g fill="white" fillOpacity="0.55">
        {[60, 90, 120, 240, 270, 300].map((x) => (
          <circle key={x} cx={x} cy="200" r="4" />
        ))}
      </g>
    </svg>
  );
}

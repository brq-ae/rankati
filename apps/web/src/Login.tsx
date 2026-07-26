import { type FormEvent, type ReactNode, useState } from 'react';
import { login } from './api';
import AuthShell, { AuthError, Field, SubmitButton, TrustToggle } from './AuthShell';

/** "Try again in Xm Ys." from the lockout's Retry-After seconds (ADR 0076). */
function lockedMessage(retryAfterSeconds: number | undefined): string {
  const total = Math.max(1, retryAfterSeconds ?? 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `Too many attempts. Try again in ${minutes}m ${seconds}s.`;
}

/**
 * Login screen (ADR 0076): username, password, "Trust this device". A wrong attempt shows a message
 * that never reveals which field was wrong; a 429 shows the lockout countdown from Retry-After.
 */
export default function Login({ onAuthenticated }: { onAuthenticated: () => void }): ReactNode {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await login({ username, password, trusted });
    if (outcome.ok) {
      onAuthenticated();
      return;
    }
    setError(outcome.status === 429 ? lockedMessage(outcome.retryAfterSeconds) : 'Wrong username or password.');
    setBusy(false);
  }

  return (
    <AuthShell title="Log in">
      <form onSubmit={onSubmit} noValidate>
        {error && <AuthError message={error} />}
        <Field id="username" label="Username" type="text" value={username} onChange={setUsername} autoComplete="username" />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <TrustToggle checked={trusted} onChange={setTrusted} />
        <SubmitButton disabled={busy}>Log in</SubmitButton>
      </form>
    </AuthShell>
  );
}

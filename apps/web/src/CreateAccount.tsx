import { type FormEvent, type ReactNode, useState } from 'react';
import { setupAccount } from './api';
import AuthShell, { AuthError, Field, SubmitButton, TrustToggle } from './AuthShell';

/**
 * First-run create-account screen (ADR 0076): username, password, a confirm field, and the same
 * "Trust this device" checkbox login has. A confirm mismatch is blocked client-side; on success the
 * server auto-logs-in (sets the cookie) and we enter the app.
 */
export default function CreateAccount({ onAuthenticated }: { onAuthenticated: () => void }): ReactNode {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setupAccount({ username, password, trusted });
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.');
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account">
      <form onSubmit={onSubmit} noValidate>
        {error && <AuthError message={error} />}
        <Field id="username" label="Username" type="text" value={username} onChange={setUsername} autoComplete="username" />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <Field
          id="confirm-password"
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        <TrustToggle checked={trusted} onChange={setTrusted} />
        <SubmitButton disabled={busy}>Create account</SubmitButton>
      </form>
    </AuthShell>
  );
}

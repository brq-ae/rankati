import { type FormEvent, type ReactNode, useState } from 'react';
import { changePassword } from './api';

const FIELD =
  'w-full rounded-xl bg-field-bg px-3 py-2 text-sm text-fg outline-none ring-1 ring-field focus:border-primary';

function Row({
  id,
  label,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <input id={id} type="password" value={value} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} className={FIELD} />
    </div>
  );
}

/**
 * Change-password form in Settings (ADR 0076). A confirm mismatch is blocked client-side (no request);
 * a wrong current password shows an inline error; success shows a brief confirmation and clears the
 * fields. On the server this also logs out every other device — noted so it is not a surprise.
 */
export default function ChangePasswordForm(): ReactNode {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setDone(false);
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await changePassword({ currentPassword: current, newPassword: next });
    setBusy(false);
    if (outcome.ok) {
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } else {
      setError('Current password is incorrect.');
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="rounded-xl bg-error-bg px-3 py-2 text-sm text-error ring-1 ring-error-edge">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="rounded-xl bg-field-bg px-3 py-2 text-sm text-positive ring-1 ring-field">
          Password changed
        </p>
      )}
      <Row id="current-password" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
      <Row id="new-password" label="New password" value={next} onChange={setNext} autoComplete="new-password" />
      <Row id="confirm-new-password" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      <button
        type="submit"
        disabled={busy}
        className="touch-manipulation self-start rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      >
        Change password
      </button>
    </form>
  );
}

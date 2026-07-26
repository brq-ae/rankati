import { type ReactNode, useState } from 'react';

/**
 * The shared chrome for the two auth screens (ADR 0076) — a centered card on the app canvas, so the
 * create-account and login screens read as one front door. Brand mark omitted deliberately: this is a
 * gate, not the app.
 */
export default function AuthShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 text-fg">
      <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-sm ring-1 ring-divider">
        <h1 className="mb-5 text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

const FIELD =
  'w-full rounded-xl bg-field-bg px-3 py-2 text-sm text-fg outline-none ring-1 ring-field focus:border-primary';

/**
 * A labelled text/password input, associated for the tests' findByLabelText (ADR 0076/0080).
 *
 * A PASSWORD field carries its own show/hide eye toggle — clicking it flips the input between
 * `type="password"` and `type="text"` so the user can SEE what is actually in the field (a
 * silently-substituted generated password becomes visible). Every input also sets
 * autocapitalize/autocorrect/spellcheck off so a mobile keyboard cannot mangle a username — or a
 * revealed password (ADR 0080).
 */
export function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  type: 'text' | 'password';
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
}): ReactNode {
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword && revealed ? 'text' : type;
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={inputType}
          value={value}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className={`${FIELD} ${isPassword ? 'pr-10' : ''}`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-sm text-muted hover:text-fg"
          >
            <span aria-hidden="true">{revealed ? '🙈' : '👁'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** The "Trust this device" checkbox — present on BOTH screens (ADR 0076). */
export function TrustToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label className="mb-4 flex items-center gap-2 text-sm text-fg">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Trust this device
    </label>
  );
}

export function SubmitButton({ children, disabled }: { children: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="w-full touch-manipulation rounded-xl bg-primary px-3 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function AuthError({ message }: { message: string }): ReactNode {
  return (
    <p role="alert" className="mb-3 rounded-xl bg-error-bg px-3 py-2 text-sm text-error ring-1 ring-error-edge">
      {message}
    </p>
  );
}

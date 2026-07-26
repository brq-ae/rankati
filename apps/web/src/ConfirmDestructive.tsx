import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The one confirmation both destructive features depend on (ADR 0064) — reset (clear-tasks and
 * factory) and list-delete. A native `<dialog>` with `showModal()`, same as SettingsModal/TaskDetail
 * (the focus trap, Escape and backdrop come with it).
 *
 * `requireTyped` is the whole graduation, one component not two: list-delete passes `false` at ≤5
 * tasks (a plain confirm) and `true` above 5; reset always passes `true`. When typed, the confirm
 * button stays disabled until the input is EXACTLY the word "DELETE" — case-sensitive, NO trimming,
 * matching the server's `confirm !== "DELETE"` guard so the two defences agree. "delete", " DELETE ",
 * "DELET" and "" are all near-misses that must NOT pass: this input is the last thing between a
 * misclick and everything gone, so near-enough is not enough.
 *
 * The blast radius is passed in as `children` — the caller computes it from the FULL task list, never
 * a location-filtered view (ADR 0061/0064). This component only displays what it is handed.
 */
const CONFIRM_WORD = 'DELETE';

export default function ConfirmDestructive({
  title,
  confirmLabel,
  requireTyped,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  /** Label on the destructive button, e.g. "Delete list", "Clear tasks", "Factory reset". */
  confirmLabel: string;
  requireTyped: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The blast radius — computed by the caller from the full task list (never a filtered view). */
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  // EXACT match: case-sensitive, no trim. Deliberately strict — see the docblock.
  const typedOk = typed === CONFIRM_WORD;
  const canConfirm = !requireTyped || typedOk;

  return (
    <dialog
      ref={dialogRef}
      // Escape, backdrop and Cancel all close the dialog, which fires this — one cancel path.
      // Confirm never closes the dialog; the caller unmounts it, so this does not double-fire.
      onClose={onCancel}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-label={title}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <div className="text-sm text-muted">{children}</div>

        {requireTyped && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">
              Type <span className="font-mono font-semibold text-fg">DELETE</span> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              // No keyboard "help": a phone must not auto-capitalise the D and make DELETE pass by
              // accident — the strictness is the point.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Type DELETE to confirm"
              className="rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
            />
          </label>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="touch-manipulation rounded-xl px-3 py-1.5 text-sm text-muted hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (canConfirm) onConfirm();
            }}
            disabled={!canConfirm}
            className="touch-manipulation rounded-xl bg-danger px-3 py-1.5 text-sm font-semibold text-danger-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

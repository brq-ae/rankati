import { useEffect, useState, type ReactNode } from 'react';
import type { List } from '@rankati/shared';

/**
 * The browse-first list combobox (ADR 0089), extracted so the task list-move (TaskDetail) and the idea
 * promote (IdeaDetail) share ONE behaviour: focus opens the menu with every list A–Z, typing narrows,
 * ↓/↑/Enter navigate with the -1 sentinel (no option pre-active on an empty query, so a stray Enter never
 * acts), a tap lands before blur closes (onMouseDown-preventDefault), and a typed new name offers "+ Create".
 * A case-insensitive exact match is picked, never duplicated. All user-facing strings are props so each host
 * keeps its own wording (TaskDetail "Move to …", IdeaDetail "Make it a task in …") — the behaviour is identical.
 */
export default function ListPickerField({
  lists,
  currentListId,
  onPick,
  onCreateAndPick,
  inputAriaLabel,
  placeholder,
  pickLabel,
  createAriaLabel,
  renderCreateLabel,
  listboxId,
  optionIdPrefix,
}: {
  lists: List[];
  /** Marks "(current)" on the matching option; omit where there is no current list (promote). */
  currentListId?: string | null;
  onPick: (listId: string) => void;
  onCreateAndPick: (name: string) => void;
  inputAriaLabel: string;
  placeholder: string;
  pickLabel: (name: string) => string;
  createAriaLabel: (name: string) => string;
  renderCreateLabel: (name: string) => ReactNode;
  listboxId: string;
  optionIdPrefix: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  // No option is pre-active on an empty (browse-all) query, so a stray Enter never silently acts;
  // typing activates the first match, arrowing activates from the top (ADR 0089).
  useEffect(() => setHighlight(query.trim() === '' ? -1 : 0), [query]);
  const typed = query.trim();
  const matches = lists
    .filter((l) => typed === '' || l.name.toLowerCase().includes(typed.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const activeIdx = highlight >= 0 && highlight < matches.length ? highlight : -1;
  const activeOption = activeIdx >= 0 ? matches[activeIdx] : undefined;
  const optionId = (id: string) => `${optionIdPrefix}${id}`;
  const exactMatch = (name: string) => lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  const pick = (id: string) => {
    onPick(id);
    setQuery('');
  };
  const createOrPick = () => {
    if (!typed) return; // reject empty/whitespace
    const existing = exactMatch(typed);
    if (existing) pick(existing.id); // case-insensitive match → select, no duplicate
    else {
      onCreateAndPick(typed); // new name → create + pick
      setQuery('');
    }
  };

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault(); // close the popup first (don't also close the modal)
            setOpen(false);
            setQuery('');
            return;
          }
          if (open && matches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setHighlight((h) =>
              e.key === 'ArrowDown' ? Math.min(h + 1, matches.length - 1) : Math.max(h - 1, 0),
            );
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && activeOption) pick(activeOption.id);
            else if (typed) createOrPick();
          }
        }}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeOption ? optionId(activeOption.id) : undefined}
        aria-label={inputAriaLabel}
        placeholder={placeholder}
        className="rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
      />
      {open && matches.length > 0 && (
        <ul id={listboxId} role="listbox" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {matches.map((l, i) => (
            <li key={l.id} role="option" id={optionId(l.id)} aria-selected={i === activeIdx}>
              <button
                type="button"
                // Keep focus on the input through the tap so onClick lands before onBlur closes it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(l.id)}
                onMouseMove={() => setHighlight(i)}
                aria-label={pickLabel(l.name)}
                className={`w-full truncate rounded-xl px-2 py-1 text-left text-sm text-strong ${
                  i === activeIdx ? 'bg-hover' : 'hover:bg-hover'
                }`}
              >
                {l.name}
                {l.id === currentListId ? ' (current)' : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* "+ Create": offered when text is typed AND no case-insensitive exact match exists (an exact
          match is pickable from the list above, so creating would duplicate it). */}
      {typed !== '' && !exactMatch(typed) && (
        <div className="mt-1 border-t border-divider pt-2">
          <button
            type="button"
            onClick={createOrPick}
            aria-label={createAriaLabel(typed)}
            className="touch-manipulation rounded-xl bg-primary px-2 py-1 text-xs font-medium text-on-primary"
          >
            {renderCreateLabel(typed)}
          </button>
        </div>
      )}
    </>
  );
}

import type { Idea, List } from '@rankati/shared';
import { useCallback, useEffect, useState } from 'react';
import { createIdea, getIdeas } from './api';
import IdeaDetail from './IdeaDetail';

/**
 * The Ideas tab (ADR 0090) — a pre-decision capture space, outside the engine (the Logs pattern). A
 * quick-add box plus a newest-first list of titles (server-ordered); a row opens the detail editor. Ideas
 * are self-managed here (like LogsView manages logs); `lists` is passed in for the promote picker, and
 * `onPromoted` lets a promotion refresh the app's tasks + lists (a promote creates engine data).
 */
export default function IdeasView({ lists, onPromoted }: { lists: List[]; onPromoted: () => void }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getIdeas()
      .then(setIdeas)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);

  const onCreate = () => {
    const t = newTitle.trim();
    if (!t) return;
    setNewTitle('');
    setError(null);
    createIdea({ title: t })
      .then(load)
      .catch((e: Error) => setError(e.message));
  };

  const openIdea = ideas.find((i) => i.id === openId) ?? null;

  return (
    <section className="flex flex-col gap-4" aria-label="Ideas">
      {error && (
        <p role="alert" className="rounded-xl bg-error-bg px-4 py-3 text-sm text-error ring-1 ring-error-edge">
          {error}
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate();
        }}
      >
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          aria-label="New idea"
          placeholder="Capture a thought…"
          className="min-w-0 flex-1 rounded-xl border border-field bg-field-bg px-3 py-2 text-base outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={newTitle.trim() === ''}
          className="touch-manipulation shrink-0 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          + New idea
        </button>
      </form>

      {ideas.length === 0 ? (
        <p className="text-sm text-faint">
          No ideas yet — jot a thought above, or in Telegram start a message with{' '}
          <span className="font-medium">#</span> to send one here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ideas.map((i) => (
            <li key={i.id} className="rounded-2xl bg-card p-3 ring-1 ring-edge">
              <button
                type="button"
                onClick={() => setOpenId(i.id)}
                aria-label={`Open ${i.title}`}
                className="w-full text-left"
              >
                <p className="truncate font-medium">{i.title}</p>
                {i.body ? <p className="truncate text-xs text-faint">{i.body}</p> : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {openIdea && (
        <IdeaDetail
          idea={openIdea}
          lists={lists}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onPromoted={onPromoted}
        />
      )}
    </section>
  );
}

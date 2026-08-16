import type { Idea, List } from '@rankati/shared';
import { useEffect, useRef, useState } from 'react';
import { convertIdeaToTask, createList, deleteIdea, updateIdea } from './api';
import ListPickerField from './ListPickerField';

/**
 * An Idea's detail (ADR 0090) — the on-open editor, a native <dialog> like LogDetail. The idea is passed
 * in BY PROP (there is no GET /ideas/:id — an idea has no day-relative state to recompute). Editable title
 * (commit on blur or Enter) and a body <textarea> (commit on blur only; newlines are content). "Make it a
 * task" is the shared browse-first ListPickerField: pick a list — or type a new name — and the idea is
 * promoted (convert copies title+body→task, deletes the idea) and the modal closes. Delete removes it.
 */
export default function IdeaDetail({
  idea,
  lists,
  onClose,
  onChanged,
  onPromoted,
}: {
  idea: Idea;
  lists: List[];
  onClose: () => void;
  /** Reload the Ideas list after an edit/delete/convert (the idea may be gone). */
  onChanged: () => void;
  /** After a promote, tell the app to refresh tasks + lists (a new task, maybe a new list, appeared). */
  onPromoted: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  // Every edit refreshes the parent list; convert/delete also close the modal.
  const act = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const commitTitle = () => {
    const t = title.trim();
    if (t && t !== idea.title) void act(updateIdea(idea.id, { title: t }));
  };
  const commitBody = () => {
    // Commit on blur only (newlines are content). '' clears (server → null); guard the no-op.
    if (body !== (idea.body ?? '')) void act(updateIdea(idea.id, { body }));
  };

  const promote = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p; // convert (+ maybe create the list first)
      onPromoted(); // the app refetches tasks + lists — a new task (and maybe list) now exists
      onChanged(); // the idea is gone from the list
      dialogRef.current?.close();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onDelete = () => {
    if (window.confirm(`Delete idea “${idea.title}”?`)) {
      deleteIdea(idea.id)
        .then(() => {
          onChanged();
          dialogRef.current?.close();
        })
        .catch((e: Error) => setError(e.message));
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-label={`Idea: ${idea.title}`}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
    >
      <div className="flex flex-col gap-4 p-5">
        {error && (
          <p role="alert" className="rounded-xl bg-error-bg px-4 py-3 text-sm text-error ring-1 ring-error-edge">
            {error}
          </p>
        )}

        {/* Title — commit on blur or Enter (single line). */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => e.key === 'Enter' && commitTitle()}
            aria-label="Idea title"
            className="rounded-xl border border-field bg-field-bg px-2 py-1 text-base outline-none focus:border-primary"
          />
        </label>

        {/* Body — the later elaboration. Commit on blur only (newlines are content). */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Notes</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={commitBody}
            rows={4}
            aria-label="Idea notes"
            placeholder="Flesh it out…"
            className="touch-manipulation resize-y rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
          />
        </label>

        {/* Make it a task — pick (or create) a list; promotion copies the idea into a task there. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Make it a task</span>
          <ListPickerField
            lists={lists}
            onPick={(listId) => void promote(convertIdeaToTask(idea.id, listId))}
            onCreateAndPick={(name) =>
              void promote(createList({ name }).then((list) => convertIdeaToTask(idea.id, list.id)))
            }
            inputAriaLabel="Make it a task in a list"
            placeholder="Pick a list, or name a new one…"
            pickLabel={(name) => `Make it a task in ${name}`}
            createAriaLabel={(name) => `Create ${name} and make it a task`}
            renderCreateLabel={(name) => <>+ Create “{name}” &amp; make it a task</>}
            listboxId="idea-promote-listbox"
            optionIdPrefix="idea-list-opt-"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${idea.title}`}
            className="touch-manipulation rounded-sm px-2 py-1.5 text-xs text-faint hover:text-danger"
          >
            Delete idea
          </button>
        </div>
      </div>
    </dialog>
  );
}

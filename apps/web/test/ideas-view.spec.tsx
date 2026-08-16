// @vitest-environment happy-dom
import type { Idea, List, Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api';
import IdeaDetail from '../src/IdeaDetail';
import IdeasView from '../src/IdeasView';

/**
 * The Ideas tab (ADR 0090) — a pre-decision capture space outside the engine. Covers the newest-first list,
 * quick-add, the Telegram-# empty-state hint, the detail title/body edits, promotion (pick a list — or
 * create one — then convert, and the list reloads without the promoted idea), and delete.
 */
vi.mock('../src/api');

const LISTS: List[] = [
  { id: 'l1', name: 'Work', ownerId: 'local' },
  { id: 'l2', name: 'Home', ownerId: 'local' },
];
const idea = (over: Partial<Idea> & { id: string; title: string }): Idea => ({
  ownerId: 'local',
  body: null,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

describe('IdeasView — the list (ADR 0090)', () => {
  it('renders ideas newest-first, exactly as the server returns them', async () => {
    vi.mocked(api.getIdeas).mockResolvedValue([
      idea({ id: 'c', title: 'third' }),
      idea({ id: 'b', title: 'second' }),
      idea({ id: 'a', title: 'first' }),
    ]);
    render(<IdeasView lists={LISTS} onPromoted={vi.fn()} />);
    await screen.findByText('third');
    const titles = screen.getAllByRole('button', { name: /^Open / }).map((b) => b.querySelector('p')?.textContent);
    expect(titles).toEqual(['third', 'second', 'first']);
  });

  it('quick-add trims and creates an idea', async () => {
    vi.mocked(api.getIdeas).mockResolvedValue([]);
    vi.mocked(api.createIdea).mockResolvedValue(idea({ id: 'n', title: 'Buy a plant' }));
    render(<IdeasView lists={LISTS} onPromoted={vi.fn()} />);
    await screen.findByText(/No ideas yet/);
    fireEvent.change(screen.getByLabelText('New idea'), { target: { value: '  Buy a plant  ' } });
    fireEvent.click(screen.getByRole('button', { name: '+ New idea' }));
    expect(api.createIdea).toHaveBeenCalledWith({ title: 'Buy a plant' });
  });

  it('the empty-state hint teaches the Telegram # shortcut', async () => {
    vi.mocked(api.getIdeas).mockResolvedValue([]);
    render(<IdeasView lists={LISTS} onPromoted={vi.fn()} />);
    expect(await screen.findByText(/start a message with/)).toBeTruthy();
    expect(screen.getByText('#')).toBeTruthy();
  });

  it('promoting picks a list, converts, calls onPromoted, and the list reloads WITHOUT the idea', async () => {
    vi.mocked(api.getIdeas)
      .mockResolvedValueOnce([idea({ id: 'a', title: 'Ship it' })])
      .mockResolvedValueOnce([]); // after convert, the idea is gone
    vi.mocked(api.convertIdeaToTask).mockResolvedValue({ id: 't1' } as Task);
    const onPromoted = vi.fn();
    render(<IdeasView lists={LISTS} onPromoted={onPromoted} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Ship it' }));
    const picker = screen.getByLabelText('Make it a task in a list');
    fireEvent.focus(picker); // browse-first: focus opens the list
    fireEvent.click(screen.getByRole('button', { name: 'Make it a task in Work' }));

    await waitFor(() => expect(api.convertIdeaToTask).toHaveBeenCalledWith('a', 'l1'));
    expect(onPromoted).toHaveBeenCalled(); // the app refetches tasks + lists
    await waitFor(() => expect(screen.queryByText('Ship it')).toBeNull()); // reloaded without it
  });
});

describe('IdeaDetail — the editor (ADR 0090)', () => {
  const open = (over: Partial<Idea> = {}) =>
    render(
      <IdeaDetail
        idea={idea({ id: 'a', title: 'Rough idea', ...over })}
        lists={LISTS}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        onPromoted={vi.fn()}
      />,
    );

  it('edits the title on blur', () => {
    vi.mocked(api.updateIdea).mockResolvedValue(idea({ id: 'a', title: 'Sharper' }));
    open();
    const input = screen.getByLabelText('Idea title');
    fireEvent.change(input, { target: { value: 'Sharper' } });
    fireEvent.blur(input);
    expect(api.updateIdea).toHaveBeenCalledWith('a', { title: 'Sharper' });
  });

  it('edits the body on blur keeping newlines; an unchanged blur sends nothing', () => {
    vi.mocked(api.updateIdea).mockResolvedValue(idea({ id: 'a', title: 'Rough idea' }));
    open();
    const body = screen.getByLabelText('Idea notes');
    fireEvent.blur(body); // no change → no write
    expect(api.updateIdea).not.toHaveBeenCalled();
    fireEvent.change(body, { target: { value: 'first\nsecond' } });
    fireEvent.blur(body);
    expect(api.updateIdea).toHaveBeenCalledWith('a', { body: 'first\nsecond' });
  });

  it('promoting to a NEW list creates the list, then converts into it', async () => {
    vi.mocked(api.createList).mockResolvedValue({ id: 'l-new', name: 'Reading', ownerId: 'local' });
    vi.mocked(api.convertIdeaToTask).mockResolvedValue({ id: 't1' } as Task);
    open();
    const picker = screen.getByLabelText('Make it a task in a list');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Reading' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Reading and make it a task/ }));
    await waitFor(() => expect(api.createList).toHaveBeenCalledWith({ name: 'Reading' }));
    expect(api.convertIdeaToTask).toHaveBeenCalledWith('a', 'l-new');
  });

  it('deletes with a confirm', async () => {
    window.confirm = vi.fn(() => true);
    vi.mocked(api.deleteIdea).mockResolvedValue(undefined);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Rough idea' }));
    await waitFor(() => expect(api.deleteIdea).toHaveBeenCalledWith('a'));
  });
});

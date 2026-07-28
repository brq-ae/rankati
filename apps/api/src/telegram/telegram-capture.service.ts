import { Injectable } from '@nestjs/common';
import type { List, Task } from '@rankati/shared';
import { LOCAL_OWNER_ID } from '../constants';
import { ListsService } from '../lists.service';
import { PrismaService } from '../prisma.service';
import { TasksService } from '../tasks.service';
import { selectRefileLists } from './telegram-callback';

const INBOX_NAME = 'Inbox';

/**
 * A Telegram capture is a task TITLE, not a note. The app puts no length limit on titles, so this is a
 * capture-side sanity cap (over-long text is truncated with an ellipsis and the reply says so — never a
 * silent drop). Change here if a global title limit is ever introduced.
 */
export const CAPTURE_TITLE_MAX = 200;

export interface CaptureResult {
  task: Task;
  inboxName: string;
  truncated: boolean;
  refileLists: List[];
  overflow: number; // candidate lists beyond the button cap, not shown
}

export type RefileResult = { status: 'moved'; listName: string } | { status: 'stale' };
export type DiscardResult = { status: 'discarded'; title: string } | { status: 'gone' };

/**
 * Capture from the bound Telegram chat (ADR 0084, Step 5): a message becomes a needsDetails task in the
 * Inbox, offered with buttons to re-file it. Re-file is the Option-B move — { listId, needsDetails: true } —
 * so the "unedited since creation" flag survives the move.
 */
@Injectable()
export class TelegramCaptureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lists: ListsService,
    private readonly tasks: TasksService,
  ) {}

  /** The owner's Inbox — found case-insensitively (it is shown/created as "Inbox"), or created plain. */
  private async findOrCreateInbox(): Promise<{ id: string; name: string }> {
    const existing = await this.prisma.list.findFirst({
      where: { ownerId: LOCAL_OWNER_ID, name: { equals: INBOX_NAME, mode: 'insensitive' } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (existing) return existing;
    return this.prisma.list.create({
      data: { name: INBOX_NAME, ownerId: LOCAL_OWNER_ID },
      select: { id: true, name: true },
    });
  }

  /** Capture free text as a needsDetails task in the Inbox, with the alphabetical re-file candidates. */
  async capture(rawText: string): Promise<CaptureResult> {
    const trimmed = rawText.trim();
    const truncated = trimmed.length > CAPTURE_TITLE_MAX;
    const title = truncated ? `${trimmed.slice(0, CAPTURE_TITLE_MAX - 1).trimEnd()}…` : trimmed;

    const inbox = await this.findOrCreateInbox();
    const task = await this.tasks.create({ title, listId: inbox.id }); // create stamps needsDetails: true
    const { shown, total } = selectRefileLists(await this.lists.findAll(), inbox.id);
    return {
      task,
      inboxName: inbox.name,
      truncated,
      refileLists: shown,
      overflow: Math.max(0, total - shown.length),
    };
  }

  /**
   * Re-file the task into another list, KEEPING needsDetails (Option B). Both rows are re-checked for
   * existence + ownership first, so a button tapped after the task or list was deleted answers cleanly
   * ('stale') instead of raising.
   */
  async refile(taskId: string, listId: string): Promise<RefileResult> {
    const [task, list] = await Promise.all([
      this.prisma.task.findFirst({ where: { id: taskId, ownerId: LOCAL_OWNER_ID }, select: { id: true } }),
      this.prisma.list.findFirst({
        where: { id: listId, ownerId: LOCAL_OWNER_ID },
        select: { id: true, name: true },
      }),
    ]);
    if (!task || !list) return { status: 'stale' };
    await this.tasks.update(taskId, { listId, needsDetails: true });
    return { status: 'moved', listName: list.name };
  }

  /**
   * Discard the just-captured task — the undo for a mistaken capture (Step 8 polish). Owner-scoped: a
   * deleted/foreign id answers 'gone', never throws. Reuses TasksService.remove (cascade + arena cleanup).
   */
  async discard(taskId: string): Promise<DiscardResult> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId: LOCAL_OWNER_ID },
      select: { id: true, title: true },
    });
    if (!task) return { status: 'gone' };
    await this.tasks.remove(task.id);
    return { status: 'discarded', title: task.title };
  }
}

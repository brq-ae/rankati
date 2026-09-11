import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AvailabilityWindow,
  CreateRequiredTaskDto,
  CreateTaskDto,
  Effort,
  Impact,
  MeetingOverlap,
  Task as TaskDto,
  TaskTier,
  UpdateTaskDto,
} from '@rankati/shared';
import { meetingSurfaced } from '@rankati/shared';
import { ArenaSessionService } from './arena/arena-session.service';
import { LOCAL_OWNER_ID } from './constants';
import { Prisma, type Task } from './generated/prisma/client';
import { MapsResolverService } from './maps-resolver.service';
import { PrismaService } from './prisma.service';
import { TASK_INCLUDE, type TaskWithRelations, toTaskDto } from './task-mapper';
import { localNow } from './telegram/telegram-time';
import { dayOfWeekOf, windowOpen } from './today/availability-window';
import { ENTRY_MULT, daysUntil, urgencyMultiplier } from './today/scoring';
import { type Block, fitPenalty, isBlock } from './today/fit';
import { inheritedUrgency } from './today/propagation';

/** Prisma: foreign key constraint failed — here, a listId that does not exist. */
const FK_VIOLATION = 'P2003';

/**
 * Either the client or a transaction of it (ADR 0054).
 *
 * The dependency guards take one of these rather than reaching for `this.prisma`, and that
 * is load-bearing rather than tidy: inside a transaction, `this.prisma` reads COMMITTED
 * state, so a task created in that same uncommitted transaction is invisible to it. The
 * guard would then refuse a brand-new prerequisite as "no such task to depend on" — the
 * inline-create path would fail on its own creation. Passing the transaction in is what
 * makes routing through the guard actually work rather than appear to.
 */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * 'YYYY-MM-DD' -> the Date a `@db.Date` column wants: UTC midnight (ADRs 0052, 0056).
 *
 * ONE strict parser, shared by notBefore and due — `field` only names which one for the
 * error, so the two calendar dates cannot validate differently and drift apart.
 *
 * Strict on purpose. `new Date('20 July 2026')` and `new Date('2026-7-20')` both "work" in
 * JS and both mean something slightly different depending on who is asking — a date field
 * must not accept a value whose meaning is negotiable. Only the calendar form the client
 * sends, `<input type="date">`'s own format, is allowed.
 *
 * The regex is not enough by itself: '2026-02-31' matches it and is not a day. Round-tripping
 * through Date catches that, because JS rolls it forward to March 3rd and the strings differ.
 */
function parseCalendarDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} must be a date as YYYY-MM-DD, or null to clear it`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} is not a real date: ${value}`);
  }
  return parsed;
}

/**
 * The declared tier, validated against the enum (ADR 0056). Rejects anything outside the four
 * members with a 400 that lists them — a bad tier is the caller's typo, not a server fault.
 * The list is `readonly TaskTier[]`, so adding a member to the shared type without adding it
 * here is a compile error rather than a silently-rejected value.
 */
const TIERS: readonly TaskTier[] = ['normal', 'important', 'super_important', 'critical'];
function parseTier(value: unknown): TaskTier {
  if (typeof value !== 'string' || !TIERS.includes(value as TaskTier)) {
    throw new BadRequestException(`tier must be one of: ${TIERS.join(', ')}`);
  }
  return value as TaskTier;
}

/**
 * The availability window, validated against the CLOSED preset set (ADR 0070) — parseTier's
 * posture exactly: outside the set is the caller's typo, a 400 that lists the members. The
 * list is `readonly AvailabilityWindow[]`, so a preset added to the shared type without being
 * added here is a compile error rather than a silently-rejected value. Anytime is not a
 * member — it is null on the field, and `update` handles null before calling this.
 */
const WINDOWS: readonly AvailabilityWindow[] = ['working_hours', 'workdays', 'weekend'];
function parseAvailabilityWindow(value: unknown): AvailabilityWindow {
  if (typeof value !== 'string' || !WINDOWS.includes(value as AvailabilityWindow)) {
    throw new BadRequestException(
      `availabilityWindow must be one of: ${WINDOWS.join(', ')}, or null to clear it back to Anytime`,
    );
  }
  return value as AvailabilityWindow;
}

/**
 * The effort bucket, validated against the closed set (ADR 0072) — parseTier/parseAvailabilityWindow
 * posture. Outside the three buckets is the caller's typo, a 400 that lists them. NULL is not a
 * member — it is untagged, and `update` handles null before calling this. The list is `readonly
 * Effort[]`, so a bucket added to the shared type without being added here is a compile error.
 */
const EFFORTS: readonly Effort[] = ['quick', 'medium', 'long'];
function parseEffort(value: unknown): Effort {
  if (typeof value !== 'string' || !EFFORTS.includes(value as Effort)) {
    throw new BadRequestException(
      `effort must be one of: ${EFFORTS.join(', ')}, or null to clear it back to untagged`,
    );
  }
  return value as Effort;
}

/**
 * The declared impact level, validated against the closed set (ADR 0075) — parseTier's posture: a value
 * outside none/medium/high is the caller's typo, a 400 that lists them. `none` IS a member (the default),
 * so unlike effort there is no null. The list is `readonly Impact[]`, so a level added to the shared type
 * without being added here is a compile error rather than a silently-rejected value.
 */
const IMPACTS: readonly Impact[] = ['none', 'medium', 'high'];
function parseImpact(value: unknown): Impact {
  if (typeof value !== 'string' || !IMPACTS.includes(value as Impact)) {
    throw new BadRequestException(`impact must be one of: ${IMPACTS.join(', ')}`);
  }
  return value as Impact;
}

/**
 * Free-text notes (ADR 0090) → their stored form — INERT, the same tri-state/trim as `Idea.body`: null or
 * an empty/whitespace-only string clears to null, a string sets (trimmed of OUTER whitespace, internal
 * newlines preserved). A non-string, non-null value is the caller's bug (400). This value is never read by
 * any ranking/gate/Today/Arena query — it only ever writes.
 */
function parseNotes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('notes must be a string or null');
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A venue link (ADR 0096) → its stored form. Same tri-state/trim as notes: null or an empty/whitespace-only
 * string clears the venue, a string sets it (trimmed). Shape-validated only — it must be a syntactically
 * valid http(s) URL, so a fat-fingered non-url is a 400 rather than a stored dud that silently never
 * resolves. The SSRF host allowlist is NOT enforced here (that is the resolver's job, best-effort at
 * resolve-time); a valid-but-non-Google url is stored and simply yields no coords. A non-string, non-null
 * value is the caller's bug (400).
 */
function parseVenueUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('venueUrl must be a string or null');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException('venueUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('venueUrl must be an http(s) URL');
  }
  return trimmed;
}

/**
 * The meeting start instant (ADR 0097) → a Date, or null to clear. Unlike notBefore/due (day-only,
 * @db.Date, ADR 0052) this is a real timestamp — the client sends a full ISO 8601 string. Only shape is
 * checked here: a value that Date can't parse is the caller's bug (400). NOT day-only-rejected — a full ISO
 * is what the client sends; a bare date parses to an instant and is accepted as-is.
 */
function parseEventAt(value: unknown): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('eventAt must be an ISO 8601 string or null');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('eventAt must be a valid ISO 8601 date-time');
  return d;
}

/** A bounded non-negative integer field (ADR 0097), tri-state null-passthrough. `field` names it for the 400. */
function parseBoundedInt(value: unknown, min: number, max: number, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestException(`${field} must be an integer between ${min} and ${max}, or null`);
  }
  return value;
}

/**
 * The FULL desired set of reminder leads (ADR 0097 + Build 3.5) → validated, DEDUPED minutes. Leads are a
 * SET (two equal leads would double-ping), each 0..43200, at most 5 per meeting (>5 → 400). `[]` is valid
 * (clear all). The reconcile against existing rows happens later; this only shapes the input.
 */
const MAX_REMINDERS = 5;
function parseReminderLeads(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('reminderLeadsMinutes must be an array of minutes (integers 0..43200), or [] to clear');
  }
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 43200) {
      throw new BadRequestException('each reminder lead must be an integer between 0 and 43200 (minutes)');
    }
  }
  const deduped = [...new Set(value as number[])];
  if (deduped.length > MAX_REMINDERS) {
    throw new BadRequestException(`a meeting can have at most ${MAX_REMINDERS} reminders`);
  }
  return deduped;
}

/**
 * The client's local TIME of day, validated — the second half of the clock context (0070).
 * Zero-padded 24h is strict for the same reason `on` is: the window check compares 'HH:MM'
 * strings, and only the zero-padded form compares chronologically ('9:30' sorts AFTER
 * '14:00' as a string — a value whose meaning is negotiable must not get in).
 */
const AT_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The free block the Today hand is being dealt against — the fit context (ADR 0072). Ephemeral
 * and OPTIONAL, unlike `on`/`at`: absent (or '') is Any, the neutral default, and fit contributes
 * nothing. A present value must be one of the three buckets or it is the caller's typo — a 400
 * that lists them, parseTier's posture — because a block whose meaning is negotiable must not
 * silently reshape the hand. It rides the Today read ONLY; Upcoming, Lists and the Arena never see it.
 */
function parseBlock(block?: string): Block | undefined {
  if (block === undefined || block === null || block === '') return undefined; // Any — neutral
  if (!isBlock(block)) {
    throw new BadRequestException('block must be one of: quick, medium, long, or omitted for Any');
  }
  return block;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arena: ArenaSessionService,
    private readonly mapsResolver: MapsResolverService,
  ) {}

  /**
   * `sort=rating` gives the ranked list the Arena earns (ADRs 0003, 0047).
   *
   * createdAt is the tie-break, not decoration: on a fresh install every rating is exactly
   * 1000, and without a stable second key the "ranking" would reshuffle on every refresh.
   */
  /**
   * The Today read — the ONLY read that applies gates (ADR 0052).
   *
   * A gate is a FILTER here, never a change to the task. The row is untouched; it is simply
   * not selected. That is precisely why the same task still turns up in the Arena, which
   * reads through eligibleWhere() and applies no gate at all — two reads, one of which
   * gates. The principle is structural rather than remembered, and tasks-today.spec.ts
   * proves a gated task still duels.
   *
   * `on` is the user's local day, sent by the client, because the client is the only thing
   * that knows it. Both boxes run UTC and the user does not: judging against the server's
   * clock would keep a task dated the 20th hidden until 04:00 local on the 20th — missing
   * its own morning, silently, looking exactly like the gate working.
   */
  /**
   * The client's local day, validated and parsed — required by both playable reads (0052). A
   * gate must not accept a date whose meaning is negotiable, and that cuts both ways: setting one
   * and asking about one use the same strict parser.
   */
  private requireDay(on?: string): { on: string; day: Date } {
    if (on === undefined || on === null || on === '') {
      throw new BadRequestException(
        'on is required: send your local day as YYYY-MM-DD. Without it this read cannot ' +
          'tell whether a gate has opened, and it will not guess.',
      );
    }
    return { on, day: parseCalendarDate(on, 'on') };
  }

  /**
   * The client's local time of day — CONDITIONALLY required, unlike `on` (ADR 0070).
   *
   * `on` is unconditional because every scored read needs it for due-date scoring. `at` is
   * needed only to judge availability windows, so an owner with no windowed tasks pays
   * nothing new: absent stays fine and the reads behave exactly as before this gate.
   *
   * The moment ANY task in the set carries a window, absence becomes a 400 — FAIL-CLOSED,
   * 0052's template. Serving the read anyway would mean either showing the windowed task
   * un-gated (every gated task reappears looking like normal operation — the failure 0052
   * names) or guessing a clock, and it will not guess. The check runs over the loaded set,
   * which makes the requirement owner-data-dependent, not client-behavior-dependent: any
   * client that sets a window commits every client to sending `at`.
   */
  private requireClock(tasks: TaskWithRelations[], at?: string): string | undefined {
    if (at !== undefined && at !== null && at !== '') {
      if (!AT_SHAPE.test(at)) {
        throw new BadRequestException('at must be a time as HH:MM (24-hour, zero-padded)');
      }
      return at;
    }
    if (tasks.some((t) => t.availabilityWindow !== null)) {
      throw new BadRequestException(
        'at is required: send your local time as HH:MM. A task here has an availability ' +
          'window, and without your clock this read cannot tell whether it is open — a ' +
          'windowed task is never served un-gated, and it will not guess.',
      );
    }
    return undefined;
  }

  /**
   * ALL active tasks + their dependency links. Backward propagation (0059) needs the tasks the gate
   * would drop — the blocked deadline source and the blocked middle of a chain — so the gate is no
   * longer in this query. It is applied after propagation, as the ONE predicate below.
   */
  private allActive(owner: string) {
    return this.prisma.task.findMany({
      include: TASK_INCLUDE,
      where: { ownerId: owner, status: 'active' },
    });
  }

  /**
   * THE gate, as a single predicate (0052, 0053) — the biggest structural change of 0059. Since
   * 0052 the gate lived in the Prisma WHERE; propagation needs the blocked tasks first, so it moved
   * here. It is still ONE definition: BOTH reads call this, and a test sabotages it and watches
   * both tabs fail together. It reads the SAME "is a prerequisite still active?" relationship the
   * propagation walk reads, so a completed blocker clears gating and severs inheritance as one act.
   */
  private isGated(task: TaskDto, activeIds: Set<string>, on: string, at?: string): boolean {
    // not-before (0052): gated until its day arrives. 'YYYY-MM-DD' string compare is chronological.
    if (task.notBefore !== null && task.notBefore > on) return true;
    // availability window (0070): gated while the preset's window is not open at the client's
    // local (day, time). The weekday is DERIVED from `on`, so day and date cannot disagree.
    // requireClock has already refused the whole read if `at` were missing while any windowed
    // task exists, so `at` is always present by the time this clause can matter.
    if (
      task.availabilityWindow !== null &&
      !windowOpen(task.availabilityWindow, dayOfWeekOf(on), at as string)
    ) {
      return true;
    }
    // dependency (0053): blocked while any prerequisite is still active — a done blocker is not in
    // the active set (not loaded), so it does not appear here, exactly as the WHERE's `not: 'done'`.
    return task.dependsOn.some((id) => activeIds.has(id));
  }

  /**
   * Split the gated set into the two playable reads by urgency (ADRs 0057, 0058). ONE place
   * classifies and orders, so "which tab" and "in what order" each have a single definition.
   *
   *   Today    = undated (always) + dated that crossed the threshold + overdue. Overdue is pinned
   *              to the top and ordered by RATING; the rest by escalated score, then SUNK by fit
   *              if too big for the block. Undated keep their exact ranked spots — their score IS
   *              their rating (times the fit penalty, which is 1 unless they are too big).
   *   Upcoming = dated below the threshold, by escalated score.
   *
   * Both tie-break newest-first (0050): the primary key desc, then createdAt desc.
   *
   * `block` is the fit term (ADR 0072) and touches the Today band ONLY: each row's sort key there
   * is score × fitPenalty, so a too-big task sinks below the fitting ones. It is confined three ways
   * — PLACEMENT (Today vs Upcoming) is decided on the UNPENALIZED score above, so fit never moves a
   * task between tabs; OVERDUE sorts by rating and never reads the penalty, so it stays pinned; and
   * UPCOMING sorts by the unpenalized score. With no block (Any) fitPenalty is 1 for every row, so
   * `fitScore === score` exactly and this band is byte-identical to before the term existed.
   */
  /** A meeting's eventAt (an instant) → its LOCAL calendar day (ADR 0097): the owner's IANA tz when known,
   * else a graceful fallback to the instant's UTC day (only near-midnight edges differ; no crash). */
  private eventLocalDay(isoInstant: string, tz: string | null): string {
    return tz ? localNow(new Date(isoInstant), tz).date : isoInstant.slice(0, 10);
  }

  private classify(
    tasks: TaskWithRelations[],
    on: string,
    tz: string | null,
    at?: string,
    block?: Block,
  ): { today: TaskDto[]; upcoming: TaskDto[] } {
    const dtos = tasks.map(toTaskDto);
    const activeIds = new Set(dtos.map((d) => d.id));
    // Propagate over the FULL active graph FIRST — before the gate hides the blocked tasks (0059).
    const inherited = inheritedUrgency(
      dtos.map((d) => ({ id: d.id, due: d.due, tier: d.tier, dependsOn: d.dependsOn })),
      on,
    );

    const rows = dtos.map((dto) => {
      const d = dto.due === null ? null : daysUntil(dto.due, on);
      const overdue = d !== null && d < 0;
      // Own urgency for non-overdue; overdue is pinned by rating, so its multiplier is unused.
      const mOwn = d !== null && d >= 0 ? urgencyMultiplier(d, dto.tier) : 1;
      const inh = inherited.get(dto.id);
      // Composition: highest wins (0059) — a task's own urgency and each inherited one, max.
      const mEff = Math.max(mOwn, inh?.multiplier ?? 0);

      // The subtext source: only when inherited STRICTLY drives the rank, and never on an overdue
      // task (its own lateness is the reason it is pinned — 0059). Set ONLY here, never in the
      // mapper, so non-scored reads (Lists, the Arena pair) never carry it.
      if (!overdue && inh && inh.multiplier > mOwn) dto.urgencySourceId = inh.sourceId;

      // Meeting Today-gate (ADR 0097): a task with a FUTURE eventAt not yet at its surfacing day is held
      // OUT of the Today hand but stays VISIBLE in Upcoming (the owner's Build-3 decision — it is NOT
      // `isGated`, which would hide it from both reads). ONLY eventAt tasks; surfaces day-of, or earlier by
      // surfaceLeadDays. tz derives the meeting's local day; degrades to its UTC day when no tz is set.
      const meetingHeldFromToday =
        dto.eventAt !== null &&
        !meetingSurfaced(this.eventLocalDay(dto.eventAt, tz), dto.surfaceLeadDays, on);

      const place = overdue
        ? 'overdue'
        : meetingHeldFromToday
          ? 'upcoming' // future meeting, not yet near — visible in Upcoming, kept out of the hand
          : dto.due === null
            ? 'today' // undated is always playable now
            : mEff >= ENTRY_MULT
              ? 'today' // dated and near enough — inherited urgency can put it here (0059)
              : 'upcoming';
      const score = dto.rating * mEff;
      // The fit term (0072): score sunk by the penalty for the Today-band sort ONLY. It is `score`
      // itself (× 1) whenever the block is Any, the task is untagged, or it fits — so this is a
      // no-op for every task on an un-blocked read. Placement above used the UNPENALIZED score, so
      // fit reorders within Today and never pushes a task across to Upcoming.
      const fitScore = score * fitPenalty(dto.effort, block);
      return { dto, place, score, fitScore, gated: this.isGated(dto, activeIds, on, at) };
    });

    type Row = (typeof rows)[number];
    const byScore = (a: Row, b: Row) => b.score - a.score || b.dto.createdAt.localeCompare(a.dto.createdAt);
    // The Today band's key: the fit-penalized score. With no block, fitScore === score exactly, so
    // this is byScore by another name — the default-neutral guarantee (0072).
    const byFitScore = (a: Row, b: Row) =>
      b.fitScore - a.fitScore || b.dto.createdAt.localeCompare(a.dto.createdAt);
    const byRating = (a: Row, b: Row) =>
      b.dto.rating - a.dto.rating || b.dto.createdAt.localeCompare(a.dto.createdAt);

    // The gate filters DISPLAY (0059's structural move); propagation already ran on the full set.
    const shown = rows.filter((r) => !r.gated);
    // Overdue by RATING — never reads fitScore, so an overdue too-big task stays pinned (0072 exempt).
    const overdue = shown.filter((r) => r.place === 'overdue').sort(byRating);
    const today = shown.filter((r) => r.place === 'today').sort(byFitScore);
    // Upcoming by the UNPENALIZED score — fit is Today-only; this band never sinks (0072).
    const upcoming = shown.filter((r) => r.place === 'upcoming').sort(byScore);
    return {
      today: [...overdue, ...today].map((r) => r.dto),
      upcoming: upcoming.map((r) => r.dto),
    };
  }

  /**
   * The Today read: what is playable now, urgency-ordered, with inherited urgency propagated back
   * along dependency chains (ADRs 0052, 0053, 0057, 0058, 0059).
   */
  /** The owner's IANA tz (ADR 0084) for deriving a meeting's local day (ADR 0097), or null when unset —
   * loaded only when a meeting is present, so a meeting-free owner pays nothing. */
  private async ownerTimezone(owner: string, tasks: TaskWithRelations[]): Promise<string | null> {
    if (!tasks.some((t) => t.eventAt !== null)) return null;
    const cfg = await this.prisma.telegramConfig.findUnique({
      where: { ownerId: owner },
      select: { timezone: true },
    });
    return cfg?.timezone ?? null;
  }

  async findToday(owner: string, on?: string, at?: string, block?: string): Promise<TaskDto[]> {
    const { on: onStr } = this.requireDay(on);
    const tasks = await this.allActive(owner);
    // The clock check needs the LOADED set: whether `at` is required depends on whether any
    // task here carries a window (0070) — see requireClock for why absence then fails closed.
    // `block` is the fit context (0072), OPTIONAL and Today-only: absent = Any = no effect.
    const tz = await this.ownerTimezone(owner, tasks);
    return this.classify(tasks, onStr, tz, this.requireClock(tasks, at), parseBlock(block)).today;
  }

  /**
   * The Upcoming read: dated, playable tasks not yet across the Today threshold, ordered by the
   * same escalated (and possibly inherited) score (ADRs 0058, 0059).
   */
  async findUpcoming(owner: string, on?: string, at?: string): Promise<TaskDto[]> {
    const { on: onStr } = this.requireDay(on);
    const tasks = await this.allActive(owner);
    const tz = await this.ownerTimezone(owner, tasks);
    return this.classify(tasks, onStr, tz, this.requireClock(tasks, at)).upcoming;
  }

  async findAll(sort?: string): Promise<TaskDto[]> {
    const orderBy: Prisma.TaskOrderByWithRelationInput[] =
      sort === 'rating'
        ? [{ rating: 'desc' }, { createdAt: 'desc' }]
        : [{ createdAt: 'desc' }];

    const tasks = await this.prisma.task.findMany({
      include: TASK_INCLUDE,
      where: { ownerId: LOCAL_OWNER_ID },
      orderBy,
    });
    return tasks.map(toTaskDto);
  }

  async findOne(id: string): Promise<TaskDto> {
    const task = await this.prisma.task.findFirst({
      include: TASK_INCLUDE,
      where: { id, ownerId: LOCAL_OWNER_ID },
    });
    if (!task) {
      throw new NotFoundException(`task ${id} not found`);
    }
    return toTaskDto(task);
  }

  async create(dto: CreateTaskDto): Promise<TaskDto> {
    const title = typeof dto?.title === 'string' ? dto.title.trim() : '';
    if (!title) {
      throw new BadRequestException('title is required');
    }
    if (typeof dto?.listId !== 'string' || !dto.listId) {
      throw new BadRequestException('listId is required');
    }

    try {
      const task = await this.prisma.task.create({
      include: TASK_INCLUDE,
        // needsDetails: true — every newly created task is stamped "unedited since creation" (ADR
        // 0073). Quick-add AND the (+) both land here, so the stamp is server-side and onAdd needs
        // no change. The first field/checklist edit clears it; a done seed task never reaches here.
        data: { title, listId: dto.listId, ownerId: LOCAL_OWNER_ID, needsDetails: true },
      });
      return toTaskDto(task);
    } catch (error) {
      // A bad listId is the caller's mistake, not a server fault — 400, not a raw 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === FK_VIOLATION) {
        throw new BadRequestException(`list ${dto.listId} does not exist`);
      }
      throw error;
    }
  }

  async complete(id: string): Promise<TaskDto> {
    const task = await this.prisma.task.findFirst({
      include: TASK_INCLUDE,
      where: { id, ownerId: LOCAL_OWNER_ID },
    });
    if (!task) {
      throw new NotFoundException(`task ${id} not found`);
    }

    // Idempotent: re-completing must not rewrite the original completedAt.
    if (task.status === 'done') {
      return toTaskDto(task);
    }

    const updated = await this.prisma.task.update({
      include: TASK_INCLUDE,
      where: { id: task.id },
      data: { status: 'done', completedAt: new Date() },
    });
    return toTaskDto(updated);
  }

  /**
   * Rename a task — edits the title only; the Arena needs a typo'd task
   * to be fixable, or it pollutes every duel it appears in.
   *
   * Editing during a sitting is fine: the title is not what a duel is about, so pending
   * taps stand.
   */

  /**
   * Refuse a dependency set that would close a cycle (ADR 0053).
   *
   * A -> B -> A means NEITHER task can ever reach Today: both permanently invisible, no
   * error raised, and the screen identical to the gate working correctly. That is the worst
   * failure shape here, so the state is made unrepresentable rather than merely unlikely.
   *
   * The check runs against the graph AS IT WOULD BE — `dependsOn` replaces the set, so the
   * task's existing links are discarded before walking, not added to. Checking the old graph
   * would pass a link that closes a loop in the new one.
   *
   * The whole link table is loaded rather than walked with a query per hop. At personal
   * scale that is one small read against a graph of tens of rows; the recursive-CTE version
   * would be faster on a graph nobody here has. If that ever stops being true, the answer is
   * a materialised closure, not a weaker rule.
   *
   * Returns the offending path (ids, blocked -> blocker order) or null.
   */
  private async findCyclePath(
    db: Db,
    taskId: string,
    dependsOnIds: string[],
  ): Promise<string[] | null> {
    const links = await db.taskDependency.findMany({
      select: { taskId: true, dependsOnId: true },
    });

    const edges = new Map<string, string[]>();
    for (const link of links) {
      const existing = edges.get(link.taskId);
      if (existing) existing.push(link.dependsOnId);
      else edges.set(link.taskId, [link.dependsOnId]);
    }
    // The task under edit gets its NEW set, replacing whatever it had — `dependsOn` is a
    // set-replace, so this is the graph as it WOULD be.
    //
    // Worth knowing: this cannot actually change the verdict. The stored graph is always
    // acyclic (this check is why), so the task's own existing links can never form a path
    // back to itself — keeping them would give the same answer. It is written this way
    // because it says what we mean, not because the alternative is wrong; a test asserting
    // the difference would be hollow, and dependency-write.spec.ts says so.
    edges.set(taskId, [...dependsOnIds]);

    // Depth-first from the task itself: if following "what this waits for" ever arrives back
    // at the task, the links would close a loop. `seen` also stops an EXISTING cycle — one a
    // direct writer could have left behind (see 0053's addendum) — from hanging this walk.
    const path: string[] = [];
    const seen = new Set<string>();

    const walk = (from: string): string[] | null => {
      path.push(from);
      for (const next of edges.get(from) ?? []) {
        if (next === taskId) return [...path, next]; // closed the loop
        if (!seen.has(next)) {
          seen.add(next);
          const found = walk(next);
          if (found) return found;
        }
      }
      path.pop();
      return null;
    };
    return walk(taskId);
  }

  /** Ids -> titles, for an error a human can act on. */
  private async describePath(db: Db, ids: string[]): Promise<string> {
    const tasks = await db.task.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true },
    });
    const titles = new Map(tasks.map((t) => [t.id, t.title]));
    return ids.map((id) => titles.get(id) ?? id).join(' -> ');
  }

  /**
   * Validate a replacement location set (ADR 0060). Returns the de-duped ids, or throws 400.
   *
   * OWNER-SCOPED, deliberately: the lookup filters by ownerId, so a location id belonging to
   * another owner is simply not found and reads as "no such location" — it can never be
   * tag-able here. Inert under one owner (0026), load-bearing the day auth lands; test-guarded
   * now while the surface is small. No cycle check — a location is a place, not another task.
   */
  private async assertLocationsExist(locationIds: unknown): Promise<string[]> {
    if (!Array.isArray(locationIds) || locationIds.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('locationIds must be an array of location ids, or [] to clear it');
    }
    const ids = [...new Set(locationIds as string[])];
    if (ids.length === 0) {
      return [];
    }
    const found = await this.prisma.location.findMany({
      where: { id: { in: ids }, ownerId: LOCAL_OWNER_ID },
      select: { id: true },
    });
    const missing = ids.filter((id) => !found.some((l) => l.id === id));
    if (missing.length > 0) {
      throw new BadRequestException(`no such location: ${missing.join(', ')}`);
    }
    return ids;
  }

  /**
   * Validate a replacement dependency set (ADR 0053). Throws; returns nothing.
   */
  private async assertDependenciesAreLegal(
    db: Db,
    taskId: string,
    dependsOn: unknown,
  ): Promise<string[]> {
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('dependsOn must be an array of task ids, or [] to clear it');
    }
    // The same id twice is the same link; the composite key would reject the second insert.
    const ids = [...new Set(dependsOn as string[])];

    if (ids.includes(taskId)) {
      // Same reason the Arena refuses a self-duel: not a judgement, a typo that deadlocks.
      throw new BadRequestException('a task cannot depend on itself');
    }

    if (ids.length > 0) {
      const found = await db.task.findMany({
        where: { id: { in: ids }, ownerId: LOCAL_OWNER_ID },
        select: { id: true },
      });
      const missing = ids.filter((id) => !found.some((t) => t.id === id));
      if (missing.length > 0) {
        throw new BadRequestException(`no such task to depend on: ${missing.join(', ')}`);
      }

      const cycle = await this.findCyclePath(db, taskId, ids);
      if (cycle) {
        throw new BadRequestException(
          `that would make a loop of dependencies, and neither task could ever be done first: ${await this.describePath(db, cycle)}`,
        );
      }
    }
    return ids;
  }

  /**
   * Create a prerequisite and link it to `id`, in ONE transaction (ADR 0054).
   *
   * All-or-nothing, deliberately. Two client calls — POST then PATCH — could create the task
   * and fail the link, leaving an orphan in a list nobody chose, with no dependency and no
   * explanation. Compensating for that in the client means the cleanup can fail too. This
   * makes the broken state unrepresentable rather than recoverable, as 0053's set-replace
   * and its write-time cycle check do.
   *
   * The link runs through the SAME guards as any other, not special-cased. A brand-new task
   * cannot close a loop — but the rule is applied rather than reasoned around, and applying
   * it is why the guards take a client: `this.prisma` would read committed state and not see
   * the task this transaction just created, refusing it as "no such task to depend on".
   *
   * Returns the UPDATED BLOCKED TASK, not the new one: the caller asked what this task now
   * requires, and its dependsOn is the answer.
   */
  async createRequired(id: string, dto: CreateRequiredTaskDto): Promise<TaskDto> {
    const title = typeof dto?.title === 'string' ? dto.title.trim() : '';
    if (!title) {
      throw new BadRequestException('title is required');
    }
    if (typeof dto?.listId !== 'string' || dto.listId.length === 0) {
      throw new BadRequestException('listId is required: choose which list the new task joins');
    }

    const blocked = await this.prisma.task.findFirst({
      include: TASK_INCLUDE,
      where: { id, ownerId: LOCAL_OWNER_ID },
    });
    if (!blocked) {
      throw new NotFoundException(`task ${id} not found`);
    }

    return this.prisma.$transaction(async (tx) => {
      const list = await tx.list.findFirst({ where: { id: dto.listId, ownerId: LOCAL_OWNER_ID } });
      if (!list) {
        throw new BadRequestException(`list ${dto.listId} does not exist`);
      }

      // The client never sends ownerId; the server stamps it (0039). Everything else is a
      // normal task: rating 1000, active, no gates (0047). needsDetails: true — an inline
      // prerequisite is a bare capture like any other create, so it is stamped too (ADR 0073).
      const prerequisite = await tx.task.create({
        data: { title, listId: list.id, ownerId: LOCAL_OWNER_ID, needsDetails: true },
      });

      // `tx`, not this.prisma — the task above does not exist outside this transaction yet.
      const next = await this.assertDependenciesAreLegal(tx, blocked.id, [
        ...blocked.blockedBy.map((link) => link.dependsOnId),
        prerequisite.id,
      ]);

      await tx.taskDependency.deleteMany({ where: { taskId: blocked.id } });
      await tx.taskDependency.createMany({
        data: next.map((dependsOnId) => ({ taskId: blocked.id, dependsOnId })),
      });

      // Adding a prerequisite is work ON THE PARENT — the same dependency change a PATCH dependsOn
      // makes — so it clears the parent's "needs details" flag too (ADR 0073), consistent with that
      // path. `update` (not a re-read) is what applies the clear and returns the fresh relations.
      return toTaskDto(
        await tx.task.update({
          include: TASK_INCLUDE,
          where: { id: blocked.id },
          data: { needsDetails: false },
        }),
      );
    });
  }

  async update(id: string, dto: UpdateTaskDto): Promise<TaskDto> {
    const data: Prisma.TaskUpdateInput = {};

    // PATCH is partial, so ABSENT and null mean different things and are read differently:
    // `'title' in dto` asks "was it sent?", where reading dto.title cannot tell a missing
    // field from an explicit null.
    if ('title' in dto) {
      const title = typeof dto.title === 'string' ? dto.title.trim() : '';
      if (!title) {
        throw new BadRequestException('title is required');
      }
      data.title = title;
    }

    if ('listId' in dto) {
      // Move to another list — ONLY the listId changes (0056 follow-on). Dependencies live in a
      // join table keyed by task id, and the rating is on the task, so neither moves with it; a
      // cross-list dependency therefore survives. The target is checked here, before the write,
      // so an unknown list is a clean 400 rather than a raw FK violation surfacing as a 500.
      const target = typeof dto.listId === 'string' ? dto.listId : '';
      if (!target) {
        throw new BadRequestException('listId must be a list id');
      }
      const exists = await this.prisma.list.findFirst({
        where: { id: target, ownerId: LOCAL_OWNER_ID },
        select: { id: true },
      });
      if (!exists) {
        throw new BadRequestException(`list ${target} does not exist`);
      }
      // Prisma changes the list through the relation, not the scalar FK. The target is already
      // proven to exist, so connect cannot fail on a missing row.
      data.list = { connect: { id: target } };
    }

    if ('notBefore' in dto) {
      // null CLEARS the gate — the only way to remove one, so it must not be confused
      // with "unchanged" (ADR 0052).
      data.notBefore = dto.notBefore === null ? null : parseCalendarDate(dto.notBefore, 'notBefore');
    }

    if ('availabilityWindow' in dto) {
      // The 0070 gate, with notBefore's tri-state: null clears the window back to Anytime —
      // the only way to un-gate, so it must not read as "unchanged" — and a value must be one
      // of the closed preset set or the parser 400s naming the members.
      data.availabilityWindow =
        dto.availabilityWindow === null ? null : parseAvailabilityWindow(dto.availabilityWindow);
    }

    if ('due' in dto) {
      // Same tri-state as notBefore: null clears the deadline, a date sets it (ADR 0056).
      data.due = dto.due === null ? null : parseCalendarDate(dto.due, 'due');
    }

    if ('tier' in dto) {
      // Two states, not three — tier is non-null with a default, so there is nothing to
      // clear; a value sets it, an absent field leaves it (ADR 0056).
      data.tier = parseTier(dto.tier);
    }

    if ('effort' in dto) {
      // The fit term's bucket (ADR 0072), tri-state like notBefore/availabilityWindow: null clears
      // it back to untagged — the only way to un-tag, so it must not read as "unchanged" — and a
      // value must be one of the closed set or the parser 400s. Storing a bucket never gates and
      // never moves a task between reads; it only reshapes the Today HAND when a block is set.
      data.effort = dto.effort === null ? null : parseEffort(dto.effort);
    }

    if ('impact' in dto) {
      // The declared impact level (ADR 0075) — two states, like tier: non-null with a default, so
      // there is no null to clear; a value sets it, an absent field leaves it. Validated against the
      // closed set or a 400. Storing it never gates and never touches ranking — it only feeds the pin.
      data.impact = parseImpact(dto.impact);
    }

    if ('needsHand' in dto) {
      // The soft "needs a hand" marker (ADR 0071) — non-null with a default, like tier: two
      // states, not three. A non-boolean is the caller's bug, not a value to coerce (400).
      // This flag never gates and never touches the read paths above — it only ever writes.
      if (typeof dto.needsHand !== 'boolean') {
        throw new BadRequestException('needsHand must be a boolean');
      }
      data.needsHand = dto.needsHand;
    }

    if ('needsDetails' in dto) {
      // The "needs details" flag's EXPLICIT toggle (ADR 0073) — the modal's "revisit later". An
      // explicit value WINS: it is written as sent and NOT force-cleared by the rule below, so a
      // PATCH sending needsDetails alone sets it (and, being a real change, clears the
      // nothing-to-update guard). Any OTHER field edit — one that omits needsDetails — clears it
      // instead (handled after the guard). The two never collide: the client sends the toggle alone.
      if (typeof dto.needsDetails !== 'boolean') {
        throw new BadRequestException('needsDetails must be a boolean');
      }
      data.needsDetails = dto.needsDetails;
    }

    if ('notes' in dto) {
      // Free-text notes (ADR 0090) — INERT display/data, the 0090 tri-state/trim: null or an
      // empty/whitespace string clears to null, a string sets (trimmed outer, internal newlines kept).
      // Being a real field edit, it clears needsDetails via the rule below (nothing special here) — and
      // it is NEVER read by any ranking/gate/Today/Arena query; it only ever writes.
      data.notes = parseNotes(dto.notes);
    }

    // Venue link (ADR 0096) — store the url verbatim (tri-state/trim like notes). The best-effort resolve
    // of coords/name happens AFTER the task is loaded below, so it can compare against the OLD url and only
    // re-resolve when the url actually CHANGES (the resolve is a network round-trip; unchanged url = no call).
    const venueInDto = 'venueUrl' in dto;
    let nextVenueUrl: string | null = null;
    if (venueInDto) {
      nextVenueUrl = parseVenueUrl(dto.venueUrl);
      data.venueUrl = nextVenueUrl;
    }

    // Meeting time (ADR 0097). eventAt is a real instant; durationMinutes/surfaceLeadDays are its satellites.
    // Clearing eventAt (null) CASCADES: the satellites and every reminder lose their anchor, so they clear
    // too — enforced here regardless of what else the PATCH sent. The reminder rows are managed in the
    // transaction below (they are child rows, like dependencies), using `effectiveEventAt` computed post-load.
    const eventInDto = 'eventAt' in dto;
    let nextEventAt: Date | null = null;
    if (eventInDto) {
      nextEventAt = parseEventAt(dto.eventAt);
      data.eventAt = nextEventAt;
    }
    const clearingEvent = eventInDto && nextEventAt === null;
    if ('durationMinutes' in dto) data.durationMinutes = parseBoundedInt(dto.durationMinutes, 1, 1440, 'durationMinutes');
    if ('surfaceLeadDays' in dto) data.surfaceLeadDays = parseBoundedInt(dto.surfaceLeadDays, 1, 365, 'surfaceLeadDays');
    if (clearingEvent) {
      // No meaning without a start instant — clear the satellites (reminders handled in the tx).
      data.durationMinutes = null;
      data.surfaceLeadDays = null;
    }
    // Validate the reminder lead SET up front (shape/dedupe/cap); the row reconcile is decided after load.
    const reminderInDto = 'reminderLeadsMinutes' in dto;
    const desiredLeads = reminderInDto ? parseReminderLeads(dto.reminderLeadsMinutes) : undefined;

    // Dependencies are not a column, so they are not part of `data` — they are rows in a
    // join table, replaced in the same transaction below.
    let nextDependencies: string[] | null = null;
    if ('dependsOn' in dto) {
      // `this.prisma`, not a transaction: everything this validates against is already
      // committed, so the plain client sees it. The read-then-write race is the one 0053's
      // addendum accepts by name — it needs two concurrent writers, and there is one user.
      // The inline-create path passes its transaction instead, because the task it links to
      // does not exist outside that transaction yet (0054).
      nextDependencies = await this.assertDependenciesAreLegal(this.prisma, id, dto.dependsOn);
    }

    // Locations are a join table too (ADR 0060), replaced the same way as dependencies. No
    // graph and so no cycle check — a location is a place, not another task.
    let nextLocations: string[] | null = null;
    if ('locationIds' in dto) {
      nextLocations = await this.assertLocationsExist(dto.locationIds);
    }

    // Nothing to do. Returning 200 here would let a caller's bug — a typo'd field name,
    // say — look exactly like a successful edit.
    if (Object.keys(data).length === 0 && nextDependencies === null && nextLocations === null && !reminderInDto) {
      throw new BadRequestException(
        'nothing to update: send title, listId, notBefore, availabilityWindow, due, tier, effort, impact, dependsOn, locationIds, needsHand, needsDetails, notes, venueUrl, eventAt, durationMinutes, surfaceLeadDays, reminderLeadsMinutes, or any combination',
      );
    }

    // Any actual field edit clears the "needs details" flag (ADR 0073) — reaching here means a real
    // change (the guard above). The ONE exception is an explicit needsDetails toggle: if the caller
    // sent it, it is already in `data` and WINS, so we do not overwrite it. Otherwise this is a
    // field edit that fleshed the task out, so the flag clears. Applied to the same write below, so
    // a dependency- or location-only edit clears it too (both pass the guard without a scalar change).
    if (!('needsDetails' in dto)) {
      data.needsDetails = false;
    }

    const task = await this.prisma.task.findFirst({
      include: TASK_INCLUDE,
      where: { id, ownerId: LOCAL_OWNER_ID },
    });
    if (!task) {
      throw new NotFoundException(`task ${id} not found`);
    }

    // Venue coords/name are a CACHE of venueUrl — refresh them ONLY when the url actually changed (ADR 0096).
    // Clearing the url (null) clears the cache too. Setting/changing it best-effort resolves: SUCCESS fills
    // lat/lng/name, a FAILURE (bad host, blocked IP, timeout, no coords) leaves them null — never fatal, so
    // G-Maps (which only needs the stored url) always works and Waze simply hides. An unchanged url skips the
    // network entirely. Coords/name are server-derived; the client cannot write them.
    if (venueInDto && nextVenueUrl !== task.venueUrl) {
      if (nextVenueUrl === null) {
        data.venueLat = null;
        data.venueLng = null;
        data.venueName = null;
      } else {
        const resolved = await this.mapsResolver.resolve(nextVenueUrl);
        data.venueLat = resolved.lat ?? null;
        data.venueLng = resolved.lng ?? null;
        data.venueName = resolved.name ?? null;
      }
    }

    // Meeting reminders (ADR 0097 + Build 3.5) — decide the child-row op now the OLD rows are loaded. The
    // list can carry several; `reconcile` diffs the DESIRED lead set against the existing rows: KEEP rows
    // whose lead stays (preserving their fire-once `sentAt`), DELETE removed ones, CREATE new-unsent ones —
    // so adding a reminder never re-fires one that already went. Cases:
    //  - clearing eventAt              -> clear all reminders (no anchor left)
    //  - reminderLeadsMinutes:[]       -> clear all
    //  - reminderLeadsMinutes:[..]     -> reconcile to that set (requires an effective eventAt; 400 otherwise)
    //  - eventAt first set, no set sent -> DEFAULT single 60-min reminder (a meeting arrives pre-armed)
    //  - eventAt CHANGED (reschedule), reminders exist, no set sent -> RE-ARM all (reset sentAt) so they ping again
    const effectiveEventAt = eventInDto ? nextEventAt : task.eventAt;
    const eventChanged = eventInDto && (task.eventAt?.getTime() ?? null) !== (nextEventAt?.getTime() ?? null);
    let remOp: 'none' | 'clear' | 'reconcile' | 'rearm' = 'none';
    let reconcileLeads: number[] = [];
    if (clearingEvent) {
      remOp = 'clear';
    } else if (reminderInDto) {
      const leads = desiredLeads as number[];
      if (leads.length === 0) {
        remOp = 'clear';
      } else {
        if (effectiveEventAt === null) {
          throw new BadRequestException('a reminder needs a meeting time — set eventAt too, or first');
        }
        remOp = 'reconcile';
        reconcileLeads = leads;
      }
    } else if (eventInDto && nextEventAt !== null) {
      if (task.eventAt === null && task.reminders.length === 0) {
        remOp = 'reconcile'; // a meeting is being added for the first time → default single 1h reminder
        reconcileLeads = [60];
      } else if (eventChanged && task.reminders.length > 0) {
        remOp = 'rearm'; // rescheduled → the existing reminders fire again
      }
    }

    // One transaction: a half-applied edit would leave the task's gates in a state the
    // user never asked for. Replacing the set means deleting what is there and inserting
    // what was sent — `dependsOn: []` therefore clears, and an absent field touches nothing
    // because nextDependencies stays null (0053).
    const updated = await this.prisma.$transaction(async (tx) => {
      if (nextDependencies !== null) {
        await tx.taskDependency.deleteMany({ where: { taskId: task.id } });
        if (nextDependencies.length > 0) {
          await tx.taskDependency.createMany({
            data: nextDependencies.map((dependsOnId) => ({ taskId: task.id, dependsOnId })),
          });
        }
      }
      if (nextLocations !== null) {
        // Replace the whole set, same as dependencies: [] clears, an absent field is untouched
        // because nextLocations stays null (0060).
        await tx.taskLocation.deleteMany({ where: { taskId: task.id } });
        if (nextLocations.length > 0) {
          await tx.taskLocation.createMany({
            data: nextLocations.map((locationId) => ({ taskId: task.id, locationId })),
          });
        }
      }
      // Meeting reminders (ADR 0097 + Build 3.5) — the child-row op decided above. `reconcile` diffs the
      // desired lead set against the existing rows: DELETE rows whose lead was dropped, CREATE rows for new
      // leads (un-sent); rows whose lead stayed are UNTOUCHED, keeping their `sentAt` so an already-fired
      // reminder never re-fires when you add another. `rearm` resets every sentAt (a reschedule).
      if (remOp === 'clear') {
        await tx.taskReminder.deleteMany({ where: { taskId: task.id } });
      } else if (remOp === 'reconcile') {
        const existingLeads = new Set(task.reminders.map((r) => r.leadMinutes));
        const target = new Set(reconcileLeads);
        const toDelete = task.reminders.filter((r) => !target.has(r.leadMinutes)).map((r) => r.id);
        if (toDelete.length > 0) await tx.taskReminder.deleteMany({ where: { id: { in: toDelete } } });
        const toCreate = reconcileLeads.filter((l) => !existingLeads.has(l));
        if (toCreate.length > 0) {
          await tx.taskReminder.createMany({ data: toCreate.map((leadMinutes) => ({ taskId: task.id, leadMinutes })) });
        }
      } else if (remOp === 'rearm') {
        await tx.taskReminder.updateMany({ where: { taskId: task.id }, data: { sentAt: null } });
      }
      return tx.task.update({
        include: TASK_INCLUDE,
        where: { id: task.id },
        data,
      });
    });

    const result = toTaskDto(updated);
    // Soft double-book advisory (ADR 0097) — ONLY when this save left the task timed. Non-blocking: the save
    // already committed above; this just annotates the response so the UI can warn. Never a 400.
    if (updated.eventAt !== null) {
      result.overlaps = await this.meetingOverlaps(LOCAL_OWNER_ID, updated.id, updated.eventAt, updated.durationMinutes);
    }
    return result;
  }

  /**
   * Other ACTIVE timed tasks whose [start,end) overlaps this one (ADR 0097). endAt = eventAt + duration is
   * computed INLINE (never stored, 0097); a task with no duration is a zero-length point. Half-open overlap:
   * `aStart < bEnd && bStart < aEnd`. Advisory only — the caller returns it on the save, never blocks.
   */
  private async meetingOverlaps(
    owner: string,
    taskId: string,
    eventAt: Date,
    durationMinutes: number | null,
  ): Promise<MeetingOverlap[]> {
    const aStart = eventAt.getTime();
    const aEnd = aStart + (durationMinutes ?? 0) * 60_000;
    const others = await this.prisma.task.findMany({
      where: { ownerId: owner, status: 'active', id: { not: taskId }, eventAt: { not: null } },
      select: { id: true, title: true, eventAt: true, durationMinutes: true },
    });
    const out: MeetingOverlap[] = [];
    for (const o of others) {
      const bStart = o.eventAt!.getTime();
      const bEnd = bStart + (o.durationMinutes ?? 0) * 60_000;
      if (aStart < bEnd && bStart < aEnd) {
        out.push({ id: o.id, title: o.title, start: o.eventAt!.toISOString(), end: new Date(bEnd).toISOString() });
      }
    }
    return out;
  }

  /**
   * Delete a task, and with it every duel it ever fought (`onDelete: Cascade`, ADR 0048).
   *
   * The honest cost, recorded in 0048 and repeated here because it is invisible from the
   * call site: those duels also informed the OTHER task's rating, so after a deletion a
   * survivor's rating can no longer be reproduced exactly by replaying the log. That is
   * the accepted price of hard delete without archiving (v0.6).
   *
   * Deleting mid-sitting also drops the task's pending taps, so undo does not later pop a
   * tap that commit was going to skip anyway.
   */
  async remove(id: string): Promise<void> {
    const task = await this.prisma.task.findFirst({
      include: TASK_INCLUDE,
      where: { id, ownerId: LOCAL_OWNER_ID },
    });
    if (!task) {
      throw new NotFoundException(`task ${id} not found`);
    }

    await this.prisma.task.delete({ where: { id: task.id } });
    this.arena.dropPendingFor(task.id);
  }
}

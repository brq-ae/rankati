import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateRoutineDto,
  FixedRule,
  IntervalUnit,
  Routine as RoutineDto,
  UpdateRoutineDto,
} from '@rankati/shared';
import { LOCAL_OWNER_ID } from '../constants';
import type { Routine } from '../generated/prisma/client';
import { LogsService } from '../logs.service';
import { PrismaService } from '../prisma.service';
import {
  addDays,
  isPeriodStale,
  nextFixedOccurrence,
  nextFloatingDue,
  periodStartOf,
} from './routine-schedule';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const requireDay = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !DAY.test(v)) throw new BadRequestException(`${field} must be YYYY-MM-DD`);
  return v;
};
const dateStr = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

/** A nag-enabled routine + its computed nag state (ADR 0091 M2) — the scheduler's read shape. */
export interface NaggableRoutine {
  row: Routine;
  /** Due AND unsatisfied for the current period (nag-due == app-due, from `toDto`). */
  shouldNag: boolean;
  /** Frequency progress ("count/target today"), or null for the interval types. */
  progress: { count: number; target: number } | null;
}
/** A `YYYY-MM-DD` from the schedule module → the UTC-midnight `Date` a `@db.Date` column expects. */
const toDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Flat rule columns → the FixedRule union the schedule module consumes. */
function ruleFromRow(r: Routine): FixedRule {
  if (r.ruleKind === 'day_of_month') return { kind: 'day_of_month', day: r.ruleDayOfMonth! };
  if (r.ruleKind === 'last_weekday_of_month') return { kind: 'last_weekday_of_month', weekday: r.ruleWeekday! };
  return { kind: 'nth_weekday_of_month', ordinal: r.ruleOrdinal!, weekday: r.ruleWeekday! };
}

/**
 * Routines (ADR 0066) — recurring rhythms wholly outside the engine. Every method is OWNER-SCOPED
 * (0026, 0039). Reads are COMPUTE-FRESH-PER-READ (0059): the frequency count reads 0 once its period
 * rolls over, and a fixed reminder's next date is computed from its rule and the client's `on` — the
 * row is never mutated by a read. Writes are single-row and take the client's local day.
 */
@Injectable()
export class RoutinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logs: LogsService,
  ) {}

  /**
   * Resolve the Telegram-nag columns (ADR 0091 M2) from a create/update dto against the CURRENT state.
   * Enabling nagging without a cadence defaults to 60m; disabling clears the cadence. Rejects a bad cadence.
   */
  private resolveNag(
    dto: { telegramNag?: boolean; nagIntervalMinutes?: number },
    current: { telegramNag: boolean; nagIntervalMinutes: number | null },
  ): { telegramNag: boolean; nagIntervalMinutes: number | null } {
    if (dto.telegramNag !== undefined && typeof dto.telegramNag !== 'boolean') {
      throw new BadRequestException('telegramNag must be a boolean');
    }
    if (dto.nagIntervalMinutes !== undefined) {
      // A custom cadence (v0.41.1): any whole number of minutes from 1 (the per-minute tick's floor) to
      // 1440 (24h). `Number.isInteger` also rejects a non-integer and NaN; the bounds reject 0 and negatives.
      const n = dto.nagIntervalMinutes;
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        throw new BadRequestException('nagIntervalMinutes must be a whole number of minutes from 1 to 1440');
      }
    }
    const telegramNag = dto.telegramNag ?? current.telegramNag;
    let nagIntervalMinutes = dto.nagIntervalMinutes ?? current.nagIntervalMinutes;
    if (telegramNag) nagIntervalMinutes = nagIntervalMinutes ?? 60; // enabling → default cadence
    else nagIntervalMinutes = null; // off → clear the cadence (and the scheduler ignores it)
    return { telegramNag, nagIntervalMinutes };
  }

  /**
   * Resolve the reminder→log link (ADR 0091 M2) — a NAME-BASED toggle: `linkLog: true` find-or-creates a
   * Log named after the routine (case-insensitive) and returns its id; `false` unlinks (never deletes the
   * Log); `undefined` = no change. Non-frequency only — the caller rejects it on a frequency routine.
   * Returns `undefined` when nothing changes so the caller omits the column from the write.
   */
  private async resolveLinkedLogId(
    linkLog: boolean | undefined,
    name: string,
    current: string | null,
  ): Promise<string | null | undefined> {
    if (linkLog === undefined) return undefined;
    if (!linkLog) return null; // unlink, keep the Log
    if (current) return current; // already linked
    const log = await this.logs.findOrCreateByName(name);
    return log.id;
  }

  /** Map a stored row to the wire DTO, computing the fresh display state against `on`. */
  private toDto(r: Routine, on: string): RoutineDto {
    const dto: RoutineDto = {
      id: r.id,
      ownerId: r.ownerId,
      name: r.name,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      snoozedUntil: r.snoozedUntil ? r.snoozedUntil.toISOString() : null,
      periodUnit: r.periodUnit,
      targetCount: r.targetCount,
      periodCount: r.periodCount,
      periodStart: dateStr(r.periodStart),
      // The DB column is RoutineUnit (day/week/month/year); create() guarantees a floating routine's
      // unit is day/week/month, so this narrowing is safe.
      intervalUnit: r.intervalUnit as IntervalUnit | null,
      intervalCount: r.intervalCount,
      preferredWeekday: r.preferredWeekday,
      nextDue: dateStr(r.nextDue),
      ruleKind: r.ruleKind,
      ruleOrdinal: r.ruleOrdinal,
      ruleWeekday: r.ruleWeekday,
      ruleDayOfMonth: r.ruleDayOfMonth,
      acknowledgedDate: dateStr(r.acknowledgedDate),
      // Telegram nag-reminders (ADR 0091 M2) — carried on reads; lastNaggedAt/nagSkipUntil stay server-only.
      telegramNag: r.telegramNag,
      nagIntervalMinutes: r.nagIntervalMinutes,
      linkedLogId: r.linkedLogId,
    };
    if (r.type === 'frequency') {
      // Compute-fresh-per-read (0059): when the period has rolled, BOTH the count and the start
      // re-anchor to the current period. Freshening only the count (as before) left `periodStart`
      // stale, so a client computing pace pressure (0066 v0.18 extension) would read a period that
      // already ended. Same source of truth (`periodStartOf`) the create/roll path uses.
      const stale = isPeriodStale(r.periodUnit!, dateStr(r.periodStart), on);
      dto.periodCount = stale ? 0 : r.periodCount;
      dto.periodStart = stale ? periodStartOf(r.periodUnit!, on) : dateStr(r.periodStart);
    } else if (r.type === 'interval_fixed') {
      const rule = ruleFromRow(r);
      let occ = nextFixedOccurrence(rule, on);
      const ack = dateStr(r.acknowledgedDate);
      if (ack !== null && occ === ack) occ = nextFixedOccurrence(rule, addDays(occ, 1));
      dto.nextDue = occ;
    }
    return dto;
  }

  async findAll(on?: string): Promise<RoutineDto[]> {
    const onStr = requireDay(on, 'on');
    const rows = await this.prisma.routine.findMany({
      where: { ownerId: LOCAL_OWNER_ID },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toDto(r, onStr));
  }

  /**
   * The Telegram-nag scheduler's read (ADR 0091 M2): every `telegramNag` routine with its RAW row (for the
   * server-only nag fields — lastNaggedAt/nagSkipUntil/snoozedUntil/nagIntervalMinutes/linkedLogId) plus
   * `shouldNag` = "due AND unsatisfied for the current period" and the frequency `progress`. `shouldNag`
   * is derived from `toDto(row, on)` — the SAME fresh state the app reads — so NAG-DUE == APP-DUE by
   * construction (no second due implementation). The snooze/skip/cadence/quiet gates are the caller's.
   */
  async naggable(on: string): Promise<NaggableRoutine[]> {
    const rows = await this.prisma.routine.findMany({
      where: { ownerId: LOCAL_OWNER_ID, telegramNag: true },
    });
    return rows.map((row) => {
      const dto = this.toDto(row, on); // the app's exact display state — the single due source
      let shouldNag = false;
      let progress: { count: number; target: number } | null = null;
      if (row.type === 'frequency') {
        const count = dto.periodCount ?? 0;
        const target = dto.targetCount ?? 0;
        progress = { count, target };
        shouldNag = count < target; // under the per-period target → still due
      } else if (row.type === 'interval_floating') {
        shouldNag = dto.nextDue !== null && dto.nextDue <= on; // due today or overdue
      } else {
        shouldNag = dto.nextDue === on; // fixed: today IS the (unacknowledged) occurrence
      }
      return { row, shouldNag, progress };
    });
  }

  /** Stamp when a routine was last nagged — the cadence anchor (ADR 0091 M2). */
  async markNagged(id: string, at: Date): Promise<void> {
    await this.prisma.routine.update({ where: { id }, data: { lastNaggedAt: at } });
  }

  async create(dto: CreateRoutineDto): Promise<RoutineDto> {
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) throw new BadRequestException('name is required');
    const on = requireDay(dto?.on, 'on');

    // Build the type-specific column set. Every routine takes rating-free defaults; nothing here
    // touches the engine.
    let data: Record<string, unknown>;
    if (dto.type === 'frequency') {
      const unit = dto.periodUnit;
      if (!unit) throw new BadRequestException('periodUnit is required for a frequency routine');
      if (!Number.isInteger(dto.targetCount) || dto.targetCount! < 1) {
        throw new BadRequestException('targetCount must be a positive integer');
      }
      data = { periodUnit: unit, targetCount: dto.targetCount, periodCount: 0, periodStart: toDate(periodStartOf(unit, on)) };
    } else if (dto.type === 'interval_floating') {
      const unit = dto.intervalUnit;
      if (unit !== 'day' && unit !== 'week' && unit !== 'month') {
        throw new BadRequestException('intervalUnit must be day, week or month');
      }
      if (!Number.isInteger(dto.intervalCount) || dto.intervalCount! < 1) {
        throw new BadRequestException('intervalCount must be a positive integer');
      }
      const pref = dto.preferredWeekday ?? null;
      if (pref !== null && (!Number.isInteger(pref) || pref < 0 || pref > 6)) {
        throw new BadRequestException('preferredWeekday must be 0–6 or null');
      }
      // firstDue given → take it as-is (the user's pick wins, no re-snap, 0066); else default one
      // interval out, snapped to the preferred weekday.
      const nextDue = dto.firstDue ? requireDay(dto.firstDue, 'firstDue') : nextFloatingDue(on, unit, dto.intervalCount!, pref);
      data = { intervalUnit: unit, intervalCount: dto.intervalCount, preferredWeekday: pref, nextDue: toDate(nextDue) };
    } else if (dto.type === 'interval_fixed') {
      data = this.ruleColumns(dto.rule);
    } else {
      throw new BadRequestException('type must be frequency, interval_floating or interval_fixed');
    }

    // Telegram nag fields (ADR 0091 M2) — apply to any type. The log link is non-frequency only.
    const nag = this.resolveNag(dto, { telegramNag: false, nagIntervalMinutes: null });
    if (dto.linkLog !== undefined && dto.type === 'frequency') {
      throw new BadRequestException('linkLog is not available on a frequency routine');
    }
    const linkedLogId = await this.resolveLinkedLogId(dto.linkLog, name, null);

    const row = await this.prisma.routine.create({
      data: {
        name,
        ownerId: LOCAL_OWNER_ID,
        type: dto.type,
        ...data,
        telegramNag: nag.telegramNag,
        nagIntervalMinutes: nag.nagIntervalMinutes,
        ...(linkedLogId !== undefined ? { linkedLogId } : {}),
      },
    });
    return this.toDto(row, on);
  }

  /** Validate a FixedRule and flatten it to columns. */
  private ruleColumns(rule: FixedRule | undefined): Record<string, unknown> {
    if (!rule) throw new BadRequestException('rule is required for a fixed routine');
    const wd = (w: number) => {
      if (!Number.isInteger(w) || w < 0 || w > 6) throw new BadRequestException('weekday must be 0–6');
      return w;
    };
    if (rule.kind === 'nth_weekday_of_month') {
      if (!Number.isInteger(rule.ordinal) || rule.ordinal < 1 || rule.ordinal > 5) {
        throw new BadRequestException('ordinal must be 1–5');
      }
      return { ruleKind: rule.kind, ruleOrdinal: rule.ordinal, ruleWeekday: wd(rule.weekday) };
    }
    if (rule.kind === 'day_of_month') {
      if (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31) {
        throw new BadRequestException('day must be 1–31');
      }
      return { ruleKind: rule.kind, ruleDayOfMonth: rule.day };
    }
    if (rule.kind === 'last_weekday_of_month') {
      return { ruleKind: rule.kind, ruleWeekday: wd(rule.weekday) };
    }
    throw new BadRequestException('unknown fixed rule kind');
  }

  /** Owner-scoped lookup — an id that isn't this owner's reads as 404, not a silent success. */
  private async own(id: string): Promise<Routine> {
    const row = await this.prisma.routine.findFirst({ where: { id, ownerId: LOCAL_OWNER_ID } });
    if (!row) throw new NotFoundException(`routine ${id} not found`);
    return row;
  }

  /**
   * Edit any field directly (ADR 0066) — the option-(c) pattern: values taken as-is, EXCEPT where a
   * derived field must follow. Only fields for the routine's own `type` may be sent; a foreign field
   * is a 400, not a silent no-op.
   */
  async update(id: string, dto: UpdateRoutineDto): Promise<RoutineDto> {
    const on = requireDay(dto?.on, 'on');
    const row = await this.own(id);
    const data: Record<string, unknown> = {};

    if (dto.name !== undefined) {
      const name = typeof dto.name === 'string' ? dto.name.trim() : '';
      if (!name) throw new BadRequestException('name is required');
      data.name = name;
    }

    if (row.type === 'frequency') {
      this.rejectForeign(dto, ['intervalUnit', 'intervalCount', 'preferredWeekday', 'nextDue', 'rule', 'linkLog']);
      if (dto.targetCount !== undefined) {
        if (!Number.isInteger(dto.targetCount) || dto.targetCount < 1) {
          throw new BadRequestException('targetCount must be a positive integer');
        }
        data.targetCount = dto.targetCount; // the current tally is KEPT (2/3 → 2/4)
      }
      if (dto.periodUnit !== undefined && dto.periodUnit !== row.periodUnit) {
        // The period is redefined; re-anchor periodStart and RESET the tally — "2 per week" cannot
        // carry into "per month".
        data.periodUnit = dto.periodUnit;
        data.periodStart = toDate(periodStartOf(dto.periodUnit, on));
        data.periodCount = 0;
      }
    } else if (row.type === 'interval_floating') {
      this.rejectForeign(dto, ['targetCount', 'periodUnit', 'rule']);
      if (dto.intervalUnit !== undefined) {
        if (dto.intervalUnit !== 'day' && dto.intervalUnit !== 'week' && dto.intervalUnit !== 'month') {
          throw new BadRequestException('intervalUnit must be day, week or month');
        }
        data.intervalUnit = dto.intervalUnit;
      }
      if (dto.intervalCount !== undefined) {
        if (!Number.isInteger(dto.intervalCount) || dto.intervalCount < 1) {
          throw new BadRequestException('intervalCount must be a positive integer');
        }
        data.intervalCount = dto.intervalCount;
      }
      if (dto.preferredWeekday !== undefined) {
        const p = dto.preferredWeekday;
        if (p !== null && (!Number.isInteger(p) || p < 0 || p > 6)) {
          throw new BadRequestException('preferredWeekday must be 0–6 or null');
        }
        data.preferredWeekday = p;
      }
      // A direct edit — no snap, no auto-shift from an interval/weekday change (same as firstDue).
      if (dto.nextDue !== undefined) data.nextDue = toDate(requireDay(dto.nextDue, 'nextDue'));
    } else {
      this.rejectForeign(dto, ['targetCount', 'periodUnit', 'intervalUnit', 'intervalCount', 'preferredWeekday', 'nextDue']);
      if (dto.rule !== undefined) {
        // Clear all rule columns, set the new kind's, and clear a now-stale dismiss. nextDue is
        // derived (computed on read), so it follows the new rule automatically.
        Object.assign(
          data,
          { ruleOrdinal: null, ruleWeekday: null, ruleDayOfMonth: null },
          this.ruleColumns(dto.rule),
          { acknowledgedDate: null },
        );
      }
    }

    // Telegram nag fields (ADR 0091 M2) — any type; only touch the columns when a nag field is actually
    // sent, so an unrelated edit doesn't rewrite them (the empty-diff guard stays honest).
    if (dto.telegramNag !== undefined || dto.nagIntervalMinutes !== undefined) {
      const nag = this.resolveNag(dto, { telegramNag: row.telegramNag, nagIntervalMinutes: row.nagIntervalMinutes });
      data.telegramNag = nag.telegramNag;
      data.nagIntervalMinutes = nag.nagIntervalMinutes;
    }
    // The log link (non-frequency — rejected above on frequency). Uses the new name if it's being changed.
    const linkedLogId = await this.resolveLinkedLogId(
      dto.linkLog,
      (data.name as string | undefined) ?? row.name,
      row.linkedLogId,
    );
    if (linkedLogId !== undefined) data.linkedLogId = linkedLogId;

    if (Object.keys(data).length === 0) return this.toDto(row, on);
    const updated = await this.prisma.routine.update({ where: { id: row.id }, data });
    return this.toDto(updated, on);
  }

  /** A field that doesn't belong to this routine's type is a client bug — 400, never a silent no-op. */
  private rejectForeign(dto: UpdateRoutineDto, foreign: (keyof UpdateRoutineDto)[]): void {
    for (const f of foreign) {
      if (dto[f] !== undefined) throw new BadRequestException(`${String(f)} is not editable on this routine's type`);
    }
  }

  async remove(id: string): Promise<void> {
    const row = await this.own(id);
    await this.prisma.routine.delete({ where: { id: row.id } });
  }

  /** "Did it" — frequency +1 (resetting a rolled-over period first); floating resets its clock. */
  async did(id: string, on?: string): Promise<RoutineDto> {
    const onStr = requireDay(on, 'on');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.routine.findFirst({ where: { id, ownerId: LOCAL_OWNER_ID } });
      if (!row) throw new NotFoundException(`routine ${id} not found`);
      if (row.type === 'frequency') {
        const stale = isPeriodStale(row.periodUnit!, dateStr(row.periodStart), onStr);
        const updated = await tx.routine.update({
          where: { id: row.id },
          data: {
            periodStart: toDate(periodStartOf(row.periodUnit!, onStr)),
            periodCount: (stale ? 0 : row.periodCount!) + 1,
          },
        });
        return this.toDto(updated, onStr);
      }
      if (row.type === 'interval_floating') {
        const updated = await tx.routine.update({
          where: { id: row.id },
          data: { nextDue: toDate(nextFloatingDue(onStr, row.intervalUnit! as IntervalUnit, row.intervalCount!, row.preferredWeekday)) },
        });
        return this.toDto(updated, onStr);
      }
      throw new BadRequestException('"Did it" applies to frequency and floating routines only');
    });
  }

  /** "Dismiss" — fixed reminders only; acknowledge the current occurrence so it recedes (persistent). */
  async dismiss(id: string, on?: string): Promise<RoutineDto> {
    const onStr = requireDay(on, 'on');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.routine.findFirst({ where: { id, ownerId: LOCAL_OWNER_ID } });
      if (!row) throw new NotFoundException(`routine ${id} not found`);
      if (row.type !== 'interval_fixed') {
        throw new BadRequestException('Dismiss applies to fixed routines only');
      }
      const occ = nextFixedOccurrence(ruleFromRow(row), onStr);
      const updated = await tx.routine.update({ where: { id: row.id }, data: { acknowledgedDate: new Date(`${occ}T00:00:00.000Z`) } });
      return this.toDto(updated, onStr);
    });
  }

  /** "Snooze" — any type; a display-only hide-until. Purely temporal; touches no schedule state. */
  async snooze(id: string, until?: string): Promise<RoutineDto> {
    if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) {
      throw new BadRequestException('until must be an ISO date-time');
    }
    const row = await this.own(id);
    const updated = await this.prisma.routine.update({ where: { id: row.id }, data: { snoozedUntil: new Date(until) } });
    // `on` for the DTO recompute: the snoozed-until day is a harmless reference; the fields that need
    // a real `on` (frequency count, fixed next-due) are re-derived by the next findAll anyway.
    return this.toDto(updated, until.slice(0, 10));
  }

  /**
   * "✓ Did it" from a Telegram nag (ADR 0091 M2): satisfy by type — frequency/floating via `did`, fixed
   * via `dismiss` — and, if the routine links a Log, also record today there via `logs.did`. GRACEFUL on a
   * DELETED linked Log (the id is soft/unconstrained): an owner-scoped 404 is swallowed so the routine is
   * still satisfied, never a crash.
   */
  async nagDid(id: string, on?: string): Promise<RoutineDto> {
    const onStr = requireDay(on, 'on');
    const row = await this.own(id); // 404 if foreign/stale
    const dto = row.type === 'interval_fixed' ? await this.dismiss(id, onStr) : await this.did(id, onStr);
    if (row.linkedLogId) {
      try {
        await this.logs.did(row.linkedLogId, onStr);
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err; // a deleted linked Log → skip; still satisfied
      }
    }
    return dto;
  }

  /**
   * "Skip today" from a nag (ADR 0091 M2): mute ONLY the nag until `until`, leaving the routine visible in
   * the app (distinct from `snooze`, the display hide). The caller passes the next-local-day instant.
   */
  async setNagSkip(id: string, until: string): Promise<void> {
    if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) {
      throw new BadRequestException('until must be an ISO date-time');
    }
    await this.own(id); // 404 if foreign/stale
    await this.prisma.routine.update({ where: { id }, data: { nagSkipUntil: new Date(until) } });
  }
}

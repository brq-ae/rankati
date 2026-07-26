import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Effort, Task, TaskTier } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The fit term (ADR 0072) over HTTP against real Postgres — the third factor of priority_now.
 *
 * Fit is a penalty MULTIPLIER on the Today-hand sort score: a task too big for the free `block`
 * sinks; a fitting task, an untagged (NULL) task, or ANY task on an un-blocked read keeps its full
 * score. The properties proved here are exactly the scope lines of 0072: default-neutral (no block
 * changes nothing), the sink, quick-fits-any / untagged-never-sinks, overdue exempt, and placement
 * (Today vs Upcoming) decided on the UNPENALIZED score so fit never moves a task between tabs.
 *
 * EVERY DATE IS INJECTED, like the scored-reads suite — `on` is fixed, each `due` relative to it.
 */
const PREFIX = '__fittest__';
const ON = '2026-07-18';
const dueAtDays = (d: number): string =>
  new Date(Date.parse(`${ON}T00:00:00.000Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe('Today fit — the sink and its confinements (real Postgres, ADR 0072)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  async function task(
    name: string,
    opts: { due?: string | null; tier?: TaskTier; rating?: number; effort?: Effort | null } = {},
  ): Promise<string> {
    const t = await prisma.task.create({
      data: {
        title: `${PREFIX} ${name}`,
        listId,
        ownerId: LOCAL_OWNER_ID,
        rating: opts.rating ?? 1000,
        tier: opts.tier ?? 'normal',
        due: opts.due ? new Date(opts.due) : null,
        effort: opts.effort ?? null,
      },
    });
    return t.id;
  }

  // block is OPTIONAL — omit it for an Any (neutral) read. `at` is sent because the real `local`
  // owner's data may carry windows (fail-closed, owner-data-dependent), exactly as the scored suite.
  const ids = async (
    tab: 'today' | 'upcoming',
    block?: Effort,
  ): Promise<string[]> => {
    const q = `on=${ON}&at=12:00${block ? `&block=${block}` : ''}`;
    const res = await agent.get(url(`/tasks/${tab}?${q}`)).expect(200);
    return (res.body as Task[]).filter((t) => t.title.startsWith(PREFIX)).map((t) => t.id);
  };

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  describe('default-neutral — the safety property (no block changes nothing)', () => {
    it('with NO block, effort tags do not move anything: order is the pure ranked order', async () => {
      // big outranks small by rating; big is tagged long (the biggest bucket). With no block, fit
      // is off, so big MUST still lead — the effort tag is inert until a block is set.
      const big = await task('big-long', { rating: 1200, effort: 'long' });
      const small = await task('small-quick', { rating: 1000, effort: 'quick' });
      expect(await ids('today')).toEqual([big, small]);
    });
  });

  describe('the sink', () => {
    it('a too-big task that leads with no block drops BELOW a fitting one once the block is set', async () => {
      const big = await task('big-long', { rating: 1200, effort: 'long' }); // 1200 > 1000...
      const small = await task('small-quick', { rating: 1000, effort: 'quick' });
      expect(await ids('today')).toEqual([big, small]); // ...leads on an un-blocked read
      // block=quick: big (long) is too big → 1200 × 0.25 = 300 < 1000 → it sinks below small.
      expect(await ids('today', 'quick')).toEqual([small, big]);
    });

    it('only STRICTLY-bigger sinks: a task equal to the block fits and keeps its place', async () => {
      const lead = await task('medium-lead', { rating: 1100, effort: 'medium' });
      const trail = await task('quick-trail', { rating: 1000, effort: 'quick' });
      // block=medium: medium is NOT > medium → no penalty → order unchanged.
      expect(await ids('today', 'medium')).toEqual([lead, trail]);
    });
  });

  describe('quick fits any block; untagged never sinks', () => {
    it('a quick task is never sunk, even by the smallest block', async () => {
      const quickLead = await task('quick-lead', { rating: 1200, effort: 'quick' });
      const longTrail = await task('long-trail', { rating: 1100, effort: 'long' });
      // block=quick sinks the long one (1100 × 0.25 = 275) but never the quick one → quick stays top.
      expect(await ids('today', 'quick')).toEqual([quickLead, longTrail]);
    });

    it('an untagged (NULL) task keeps its full score under any block', async () => {
      const untagged = await task('untagged-1000', { rating: 1000, effort: null });
      const fits = await task('quick-900', { rating: 900, effort: 'quick' });
      // block=quick: untagged is not penalized (1000), quick fits (900) → order by rating, unchanged.
      expect(await ids('today', 'quick')).toEqual([untagged, fits]);
    });
  });

  describe('overdue is EXEMPT from fit (stays pinned)', () => {
    it('an overdue too-big task stays at the top even with the smallest block set', async () => {
      const overdueBig = await task('overdue-long', { due: dueAtDays(-1), rating: 900, effort: 'long' });
      const fittingNow = await task('undated-quick', { rating: 1000, effort: 'quick' });
      // Overdue is pinned above the today band and ordered by rating — it never reads the penalty.
      expect(await ids('today', 'quick')).toEqual([overdueBig, fittingNow]);
    });
  });

  describe('placement is untouched — fit never moves a task between tabs', () => {
    it('a too-big dated task in Today stays in Today under a block (it sinks, it does not leave)', async () => {
      // Near-due critical → Today by the unpenalized score; tagged long. A quick block sinks it
      // WITHIN Today, but placement used the unpenalized score, so it must not fall to Upcoming.
      const big = await task('near-long', { due: dueAtDays(7), tier: 'critical', effort: 'long' });
      expect(await ids('today', 'quick')).toContain(big);
      expect(await ids('upcoming')).not.toContain(big);
    });

    it('Upcoming is identical whether or not the caller is holding a block (Upcoming ignores it)', async () => {
      const far = await task('far-long', { due: dueAtDays(20), tier: 'critical', effort: 'long' });
      // The Upcoming read takes no block param; the fixture confirms the long task sits there
      // unpenalized regardless of any block the Today hand is using.
      expect(await ids('upcoming')).toEqual([far]);
    });
  });

  describe('the block param is validated (0072, parseTier posture)', () => {
    it('a garbage block is a 400 that will not silently reshape the hand', async () => {
      await agent
        .get(url(`/tasks/today?on=${ON}&at=12:00&block=huge`))
        .expect(400);
    });

    it('an empty block is Any — accepted, neutral', async () => {
      await agent.get(url(`/tasks/today?on=${ON}&at=12:00&block=`)).expect(200);
    });
  });
});

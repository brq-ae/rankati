import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Idea, Task } from '@rankati/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { loginAgent } from './_auth';

/**
 * The Ideas endpoints (ADR 0090) — a pre-decision capture space, wholly outside the engine (the Logs 0087
 * pattern). Behind the global session guard + CSRF. Covers CRUD, newest-first ordering, the body tri-state,
 * owner-scoped 404s, and `convert`: the transactional promotion into a Task in a PICKED list (title+notes+
 * needsDetails, idea deleted), the 400 on a bad/foreign listId with the idea left intact, and — for the
 * companion `Task.notes` field — the round-trip and its clearing of needsDetails.
 */
describe('Ideas endpoints (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  const url = (p: string) => `/${API_PREFIX}${p}`;
  const makeIdea = (title: string, body?: string | null) =>
    agent.post(url('/ideas')).send(body === undefined ? { title } : { title, body });

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    await prisma.idea.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await prisma.task.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await prisma.list.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
  });

  afterAll(async () => {
    await prisma?.idea.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await prisma?.task.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await prisma?.list.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await app?.close();
  });

  const makeList = async (name: string): Promise<string> =>
    ((await agent.post(url('/lists')).send({ name }).expect(201)).body as { id: string }).id;

  // ---- CRUD ---------------------------------------------------------------

  it('POST /ideas creates an Idea; trims the title and rejects a blank one', async () => {
    const idea = (await makeIdea('  Try a standing desk  ').expect(201)).body as Idea;
    expect(idea.title).toBe('Try a standing desk');
    expect(idea.body).toBeNull();
    expect(idea).toHaveProperty('createdAt');
    expect(idea).toHaveProperty('updatedAt');
    await makeIdea('   ').expect(400);
  });

  it('POST /ideas accepts a body, trimming outer whitespace but keeping internal newlines', async () => {
    const idea = (await makeIdea('Blog post', '  line one\nline two  ').expect(201)).body as Idea;
    expect(idea.body).toBe('line one\nline two');
    // an empty/whitespace body stores as null
    expect(((await makeIdea('Empty body', '   ').expect(201)).body as Idea).body).toBeNull();
  });

  it('GET /ideas lists the owner ideas NEWEST-FIRST (createdAt desc)', async () => {
    await makeIdea('first').expect(201);
    await makeIdea('second').expect(201);
    await makeIdea('third').expect(201);
    const ideas = (await agent.get(url('/ideas')).expect(200)).body as Idea[];
    expect(ideas.map((i) => i.title)).toEqual(['third', 'second', 'first']);
  });

  it('PATCH /ideas/:id edits title and body (tri-state); null clears the body', async () => {
    const id = ((await makeIdea('rough', 'first thoughts').expect(201)).body as Idea).id;
    const renamed = (await agent.patch(url(`/ideas/${id}`)).send({ title: '  sharper  ' }).expect(200))
      .body as Idea;
    expect(renamed.title).toBe('sharper');
    expect(renamed.body).toBe('first thoughts'); // body left untouched when omitted
    const cleared = (await agent.patch(url(`/ideas/${id}`)).send({ body: null }).expect(200)).body as Idea;
    expect(cleared.body).toBeNull();
    // an empty title is rejected — an idea always has a title
    await agent.patch(url(`/ideas/${id}`)).send({ title: '   ' }).expect(400);
    // an empty PATCH is a 400, not a silent no-op
    await agent.patch(url(`/ideas/${id}`)).send({}).expect(400);
  });

  it('DELETE /ideas/:id removes it (204), then it is gone (404)', async () => {
    const id = ((await makeIdea('scrap this').expect(201)).body as Idea).id;
    await agent.delete(url(`/ideas/${id}`)).expect(204);
    await agent.patch(url(`/ideas/${id}`)).send({ title: 'x' }).expect(404);
  });

  it('foreign/stale ids are a clean 404 on every mutating route, never a silent success', async () => {
    const ghost = randomUUID();
    const listId = await makeList('Somewhere');
    await agent.patch(url(`/ideas/${ghost}`)).send({ title: 'x' }).expect(404);
    await agent.delete(url(`/ideas/${ghost}`)).expect(404);
    await agent.post(url(`/ideas/${ghost}/convert`)).send({ listId }).expect(404);
  });

  // ---- convert (promotion) -----------------------------------------------

  it('POST /ideas/:id/convert creates the Task in the PICKED list with title+notes+needsDetails, and deletes the idea', async () => {
    const listId = await makeList('Projects');
    const id = ((await makeIdea('Ship the newsletter', 'monthly, 500 words').expect(201)).body as Idea)
      .id;

    const task = (await agent.post(url(`/ideas/${id}/convert`)).send({ listId }).expect(201)).body as Task;
    expect(task.title).toBe('Ship the newsletter');
    expect(task.notes).toBe('monthly, 500 words'); // body -> notes
    expect(task.listId).toBe(listId); // the picked list, no Inbox
    expect(task.needsDetails).toBe(true); // convert is a CREATE, not an edit — the flag stays set

    // the idea is gone…
    await agent.patch(url(`/ideas/${id}`)).send({ title: 'x' }).expect(404);
    expect((await agent.get(url('/ideas')).expect(200)).body).toEqual([]);
    // …and the task truly exists on the server
    const stored = await prisma.task.findFirst({ where: { id: task.id } });
    expect(stored?.notes).toBe('monthly, 500 words');
  });

  it('convert 400s on a bad/foreign listId and leaves the idea intact — no orphaned task (rollback-safe)', async () => {
    const id = ((await makeIdea('Keep me').expect(201)).body as Idea).id;
    const before = await prisma.task.count({ where: { ownerId: LOCAL_OWNER_ID } });

    await agent.post(url(`/ideas/${id}/convert`)).send({ listId: randomUUID() }).expect(400);
    await agent.post(url(`/ideas/${id}/convert`)).send({}).expect(400); // listId required

    // the idea survives and no task was created — the transaction never partially applied
    const ideas = (await agent.get(url('/ideas')).expect(200)).body as Idea[];
    expect(ideas.map((i) => i.title)).toEqual(['Keep me']);
    expect(await prisma.task.count({ where: { ownerId: LOCAL_OWNER_ID } })).toBe(before);
  });

  // ---- Task.notes (the companion inert field) -----------------------------

  it('PATCH /tasks/:id notes round-trips (tri-state) and clears needsDetails; internal newlines kept', async () => {
    const listId = await makeList('Work');
    const task = (await agent.post(url('/tasks')).send({ title: 'Draft', listId }).expect(201))
      .body as Task;
    expect(task.needsDetails).toBe(true); // fresh create is stamped (0073)
    expect(task.notes).toBeNull();

    const noted = (
      await agent.patch(url(`/tasks/${task.id}`)).send({ notes: '  a\nb  ' }).expect(200)
    ).body as Task;
    expect(noted.notes).toBe('a\nb'); // outer trimmed, internal newline kept
    expect(noted.needsDetails).toBe(false); // a real field edit clears the flag (0073)

    // null clears back to no notes
    expect(((await agent.patch(url(`/tasks/${task.id}`)).send({ notes: null }).expect(200)).body as Task).notes).toBeNull();
    // an empty/whitespace string also clears to null
    expect(((await agent.patch(url(`/tasks/${task.id}`)).send({ notes: '   ' }).expect(200)).body as Task).notes).toBeNull();
  });
});

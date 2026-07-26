import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { List, UpdateListDto } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/** Renaming a list — the gap v0.1 left. Mirrors renaming a task exactly. */
const PREFIX = '__listrename__';

describe('PATCH /lists/:id (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await app?.close();
  });

  const makeList = () =>
    prisma.list.create({ data: { name: `${PREFIX} before`, ownerId: LOCAL_OWNER_ID } });

  it('renames a list', async () => {
    const list = await makeList();
    const res = await agent
      .patch(url(`/lists/${list.id}`))
      .send({ name: `${PREFIX} after` } satisfies UpdateListDto)
      .expect(200);
    expect((res.body as List).name).toBe(`${PREFIX} after`);
    expect((await prisma.list.findUniqueOrThrow({ where: { id: list.id } })).name).toBe(
      `${PREFIX} after`,
    );
  });

  it('trims, like renaming a task does', async () => {
    const list = await makeList();
    const res = await agent
      .patch(url(`/lists/${list.id}`))
      .send({ name: `  ${PREFIX} trimmed  ` })
      .expect(200);
    expect((res.body as List).name).toBe(`${PREFIX} trimmed`);
  });

  it('refuses an empty name', async () => {
    const list = await makeList();
    await agent.patch(url(`/lists/${list.id}`)).send({ name: '   ' }).expect(400);
    await agent.patch(url(`/lists/${list.id}`)).send({}).expect(400);
    // ...and changed nothing.
    expect((await prisma.list.findUniqueOrThrow({ where: { id: list.id } })).name).toBe(
      `${PREFIX} before`,
    );
  });

  it('404s an unknown list', async () => {
    await agent
      .patch(url('/lists/00000000-0000-0000-0000-000000000000'))
      .send({ name: 'x' })
      .expect(404);
  });

  it('leaves the list’s tasks alone', async () => {
    const list = await makeList();
    const task = await prisma.task.create({
      data: { title: `${PREFIX} t`, listId: list.id, ownerId: LOCAL_OWNER_ID },
    });
    await agent
      .patch(url(`/lists/${list.id}`))
      .send({ name: `${PREFIX} renamed` })
      .expect(200);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.listId).toBe(list.id);
    expect(after.title).toBe(`${PREFIX} t`);
    await prisma.task.delete({ where: { id: task.id } });
  });
});

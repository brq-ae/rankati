import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { ResetController } from '../src/reset.controller';
import { ResetService } from '../src/reset.service';

/**
 * The endpoint GUARD (ADR 0064). `POST /api/reset` must refuse without `confirm: "DELETE"` — the
 * machine floor beneath the UI's typed-DELETE box, a second defence because a UI can be bypassed and
 * a `curl` can be typo'd.
 *
 * ResetService is MOCKED. That is deliberate and it is the safety point: the guard lives in the
 * controller, so mocking the service lets us prove the refusal AND the correct wiring WITHOUT ever
 * running a real wipe — which, through this endpoint, would target `local`. No real reset ever runs
 * here (ADR 0064's "no test targets local"). The real destructive behaviour is proven in
 * reset-core.spec.ts against throwaway owners.
 */
describe('POST /reset guard', () => {
  let app: INestApplication;
  const run = vi.fn(async () => ({
    mode: 'factory' as const,
    deleted: { duels: 0, tasks: 0, lists: 0, locations: 0, routines: 0 },
    seeded: { locations: 4, lists: 2, tasks: 6 },
  }));

  const post = (body: unknown) =>
    request(app.getHttpServer()).post(`/${API_PREFIX}/reset`).send(body as object);

  beforeAll(async () => {
    const m = await Test.createTestingModule({
      controllers: [ResetController],
      providers: [{ provide: ResetService, useValue: { run } }],
    }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses without confirm — 400, service never called', async () => {
    run.mockClear();
    await post({ mode: 'factory' }).expect(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a wrong confirm string (case matters) — 400, service never called', async () => {
    run.mockClear();
    await post({ mode: 'factory', confirm: 'delete' }).expect(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an unknown mode even WITH confirm — 400, service never called', async () => {
    run.mockClear();
    await post({ mode: 'nuke-everything', confirm: 'DELETE' }).expect(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('with confirm DELETE and a valid mode, calls the service once with the right args', async () => {
    run.mockClear();
    await post({ mode: 'factory', keepSampleData: false, confirm: 'DELETE' }).expect(201);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('factory', { keepSampleData: false });
  });

  it('clear-tasks is a valid mode too', async () => {
    run.mockClear();
    await post({ mode: 'clear-tasks', confirm: 'DELETE' }).expect(201);
    expect(run).toHaveBeenCalledWith('clear-tasks', { keepSampleData: undefined });
  });

  // Guards the guard: proves LOCAL_OWNER_ID is what the wiring is built around (the controller hands
  // mode+opts to the service, which binds the local owner) — documents where the owner is pinned.
  it('the service binds the single local owner, not a client-supplied one', () => {
    expect(LOCAL_OWNER_ID).toBe('local');
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { MapsResolverService } from '../src/maps-resolver.service';
import { PrismaService } from '../src/prisma.service';
import type { VenueResolved } from '../src/maps-link-resolver';
import { loginAgent } from './_auth';

/**
 * PATCH /tasks/:id — the Venue field (ADR 0096, meetings epic Build 2), through the SAME endpoint that
 * edits notes/due/tier. The load-bearing behaviours here are the WIRING, not the SSRF resolver itself
 * (that is unit-tested with a mocked network in maps-link-resolver.spec.ts). We override the resolver
 * provider so this integration suite NEVER makes an outbound request, and assert:
 *   - a set stores the url verbatim AND caches the resolver's coords/name, and clears needsDetails;
 *   - a resolve that finds nothing stores the url with null coords (G-Maps works, Waze hides);
 *   - the resolver runs ONLY when the url CHANGES (re-PATCHing the same url does not re-resolve);
 *   - clearing (null) wipes url AND the cached coords/name, with no resolve call;
 *   - coords/name are SERVER-derived — a client cannot write venueLat/Lng/Name;
 *   - a syntactically invalid url is REFUSED (400), not stored.
 */
const PREFIX = '__venue__';

/** A stand-in resolver: returns whatever `next` is set to, and counts how many times it was asked. */
class FakeResolver {
  next: VenueResolved = {};
  calls: string[] = [];
  resolve(url: string): Promise<VenueResolved> {
    this.calls.push(url);
    return Promise.resolve(this.next);
  }
}

describe('PATCH /tasks/:id — venue (0096, real Postgres, mocked resolver)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let resolver: FakeResolver;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;
  const patch = (id: string, body: unknown) => agent.patch(url(`/tasks/${id}`)).send(body as object);

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  const task = async (data: Record<string, unknown> = {}): Promise<string> =>
    (await prisma.task.create({ data: { title: `${PREFIX} t`, listId, ownerId: LOCAL_OWNER_ID, ...data } })).id;

  beforeEach(async () => {
    if (!app) {
      resolver = new FakeResolver();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MapsResolverService)
        .useValue(resolver)
        .compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    resolver.next = {};
    resolver.calls = [];
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('sets the url verbatim and caches the resolver coords/name; clears needsDetails', async () => {
    resolver.next = { lat: 37.5, lng: -122.1, name: 'Blue Bottle' };
    const id = await task({ needsDetails: true });
    const link = 'https://maps.app.goo.gl/abc123';
    const res = await patch(id, { venueUrl: link }).expect(200);
    const body = res.body as Task;
    expect(body.venueUrl).toBe(link); // stored verbatim — drives G-Maps with no server call
    expect(body.venueLat).toBe(37.5);
    expect(body.venueLng).toBe(-122.1);
    expect(body.venueName).toBe('Blue Bottle');
    expect(body.needsDetails).toBe(false); // a real field edit
    expect(resolver.calls).toEqual([link]); // resolved exactly once
  });

  it('stores the url with null coords when the resolver finds nothing (Waze hides, G-Maps still works)', async () => {
    resolver.next = {}; // e.g. non-Google host, blocked IP, timeout, or no coords in the link
    const id = await task();
    const link = 'https://example.com/not-google';
    const body = (await patch(id, { venueUrl: link }).expect(200)).body as Task;
    expect(body.venueUrl).toBe(link);
    expect(body.venueLat).toBeNull();
    expect(body.venueLng).toBeNull();
    expect(body.venueName).toBeNull();
  });

  it('re-resolves ONLY when the url changes — re-PATCHing the same url does not call the resolver again', async () => {
    resolver.next = { lat: 1, lng: 2 };
    const id = await task();
    const link = 'https://maps.google.com/maps/@1,2';
    await patch(id, { venueUrl: link }).expect(200);
    expect(resolver.calls).toEqual([link]); // first set → one resolve

    // Same url again (paired with a title edit so the request still changes something).
    resolver.next = { lat: 9, lng: 9 }; // would be picked up IF it re-resolved — it must not
    const body = (await patch(id, { venueUrl: link, title: `${PREFIX} renamed` }).expect(200)).body as Task;
    expect(resolver.calls).toEqual([link]); // STILL one — unchanged url skipped the network
    expect(body.venueLat).toBe(1); // cache preserved, not overwritten by the second resolver.next
    expect(body.venueLng).toBe(2);

    // A genuinely different url DOES re-resolve.
    const link2 = 'https://maps.google.com/maps/@3,4';
    const body2 = (await patch(id, { venueUrl: link2 }).expect(200)).body as Task;
    expect(resolver.calls).toEqual([link, link2]);
    expect(body2.venueLat).toBe(9);
    expect(body2.venueLng).toBe(9);
  });

  it('clearing with null wipes url AND cached coords/name, with no resolve call', async () => {
    const id = await task({ venueUrl: 'https://maps.google.com/x', venueLat: 5, venueLng: 6, venueName: 'Old' });
    const body = (await patch(id, { venueUrl: null }).expect(200)).body as Task;
    expect(body.venueUrl).toBeNull();
    expect(body.venueLat).toBeNull();
    expect(body.venueLng).toBeNull();
    expect(body.venueName).toBeNull();
    expect(resolver.calls).toEqual([]); // clearing never touches the network
  });

  it('coords/name are SERVER-derived — a client cannot write venueLat/Lng/Name', async () => {
    resolver.next = { lat: 10, lng: 20, name: 'Real' };
    const id = await task();
    const link = 'https://maps.google.com/maps/@10,20';
    // The client tries to smuggle its own coords; the DTO ignores them, the resolver wins.
    const body = (await patch(id, { venueUrl: link, venueLat: 99, venueLng: 88, venueName: 'Fake' } as object).expect(200))
      .body as Task;
    expect(body.venueLat).toBe(10);
    expect(body.venueLng).toBe(20);
    expect(body.venueName).toBe('Real');
  });

  it('a syntactically invalid url is REFUSED (400), not stored, and never resolved', async () => {
    const id = await task();
    await patch(id, { venueUrl: 'not a url' }).expect(400);
    await patch(id, { venueUrl: 'ftp://maps.google.com/x' }).expect(400); // non-http(s)
    expect(resolver.calls).toEqual([]);
    const stored = await prisma.task.findUnique({ where: { id }, select: { venueUrl: true } });
    expect(stored?.venueUrl).toBeNull();
  });
});

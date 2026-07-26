import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type MockInstance, afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { CLIENT_ERROR_LIMITER, RateLimiter } from '../src/client-error.ratelimit';
import { API_PREFIX } from '../src/constants';

/**
 * POST /api/client-error (ADR 0078): public (errors happen before login), log-only (spy the Logger),
 * size-capped (413), and rate-limited (429). The public exemption and the rate limit are the
 * load-bearing guards, bite-tested. A small test limiter makes the 429 case fast and isolated.
 */
describe('client-error endpoint (real HTTP, ADR 0078)', () => {
  let app: INestApplication;
  let warnSpy: MockInstance;
  const limiter = new RateLimiter(3, 60_000); // small + resettable, for a deterministic 429
  const url = (path: string): string => `/${API_PREFIX}${path}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLIENT_ERROR_LIMITER)
      .useValue(limiter)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  });
  beforeEach(() => {
    limiter.reset(); // isolate each test's hits
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());
  afterAll(async () => {
    await app?.close();
  });

  it('a well-formed report → 204 AND the logger is called with the greppable context', async () => {
    await request(app.getHttpServer())
      .post(url('/client-error'))
      .send({
        message: 'Cannot read properties of undefined',
        stack: 'Error: boom\n  at Foo (App.tsx:12)',
        view: 'Today',
        appVersion: '0.25.0',
        userAgent: 'TestAgent/1.0',
        timestamp: '2026-07-25T12:00:00.000Z',
      })
      .expect(204);

    const lines = warnSpy.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes('[client-error]'));
    expect(line).toBeDefined();
    expect(line).toContain('view=Today');
    expect(line).toContain('v=0.25.0');
    expect(line).toContain('msg="Cannot read properties of undefined"');
    expect(lines.some((l) => l.includes('stack:'))).toBe(true); // the stack follows on its own line
  });

  it('NO session cookie → still accepted (NOT 401) — it is @Public', async () => {
    await request(app.getHttpServer())
      .post(url('/client-error'))
      .send({ message: 'pre-login crash on the login screen', view: 'Login' })
      .expect(204);
  });

  it('an oversized payload → 413 (rejected before it can bloat the log)', async () => {
    await request(app.getHttpServer())
      .post(url('/client-error'))
      .send({ message: 'x'.repeat(20 * 1024) }) // ~20 KB, over the 16 KB cap
      .expect(413);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[client-error]'))).toBe(false);
  });

  it('exceeding the rate limit → 429 (the server backstop)', async () => {
    for (let i = 1; i <= 3; i++) {
      await request(app.getHttpServer()).post(url('/client-error')).send({ message: `hit ${i}` }).expect(204);
    }
    await request(app.getHttpServer()).post(url('/client-error')).send({ message: 'over the limit' }).expect(429);
  });

  it('a minimal payload (message only) → accepted; junk/extra fields ignored', async () => {
    await request(app.getHttpServer())
      .post(url('/client-error'))
      .send({ message: 'just a message', nonsense: { a: 1 }, evil: 'ignored' })
      .expect(204);
    const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[client-error]'));
    expect(line).toContain('msg="just a message"');
    expect(line).toContain('view=unknown'); // absent view defaults, extras never appear
    expect(line).not.toContain('nonsense');
  });

  it('an empty message → 400 (a report must carry at least a message)', async () => {
    await request(app.getHttpServer()).post(url('/client-error')).send({ view: 'Today' }).expect(400);
  });
});

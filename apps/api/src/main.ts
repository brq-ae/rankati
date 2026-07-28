import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { API_PREFIX } from './constants';
import { TelegramBotService } from './telegram/telegram-bot.service';
import { TelegramDigestService } from './telegram/telegram-digest.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Graceful shutdown: let OnModuleDestroy fire on SIGTERM so the Telegram poller stops cleanly (ADR 0084).
  app.enableShutdownHooks();

  // Rankati runs only behind a TLS-terminating reverse proxy (ADR 0077); trust its forwarded headers so
  // X-Forwarded-Proto drives the Secure cookie and req.ip reflects the real client, not the proxy.
  app.set('trust proxy', 1);

  // Every route lives under /api — one rule, no exceptions, so a single published
  // port can serve the web app and the API from one origin (ADR 0042).
  app.setGlobalPrefix(API_PREFIX);

  // No CORS: dev reaches the API through Vite's /api proxy and prod through the web
  // container's proxy, so every request is same-origin (ADR 0042).

  const config = app.get(ConfigService);
  const port = Number(config.get<string>('API_PORT') ?? 3000);
  // Loopback in dev — the browser never addresses the API directly (ADR 0042).
  // The container overrides this to 0.0.0.0 so the web service can reach it.
  const host = config.get<string>('API_HOST') ?? '127.0.0.1';

  await app.listen(port, host);

  // Start the Telegram long-poll loop if a token is configured (ADR 0084). Done HERE, after listen — not
  // in a module lifecycle hook — so the test harness (Test.createTestingModule + app.init) never opens a
  // real poller against Telegram.
  await app.get(TelegramBotService).syncFromConfig();

  // Start the daily-digest scheduler's per-minute tick (Step 7). Also HERE, not in a module hook, so tests
  // never open a real interval; the tick logic itself is exercised directly with a fake clock.
  app.get(TelegramDigestService).start();
}

void bootstrap();

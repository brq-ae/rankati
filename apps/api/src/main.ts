import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { API_PREFIX } from './constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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
}

void bootstrap();

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  PayloadTooLargeException,
  Post,
  Req,
} from '@nestjs/common';
import { firstHeader, type HttpRequestLike } from './auth/cookie';
import { Public } from './auth/public.decorator';
import { CLIENT_ERROR_LIMITER, RateLimiter } from './client-error.ratelimit';

/** Reject anything larger than this before it can bloat the log; body-parser's own 100kb cap is behind us. */
const MAX_BODY_BYTES = 16 * 1024;
/** Per-field truncation backstop so a giant stack becomes a long line, never a log-blowing one. */
const MAX_FIELD = 4096;

interface ClientErrorBody {
  message?: unknown;
  stack?: unknown;
  view?: unknown;
  appVersion?: unknown;
  userAgent?: unknown;
  timestamp?: unknown;
}

/** @Req only needs the client IP (Express, honouring `trust proxy`) plus the headers HttpRequestLike has. */
interface ClientErrorRequest extends HttpRequestLike {
  ip?: string;
  socket?: { remoteAddress?: string };
}

/** A non-empty trimmed string, truncated to `max`; anything else → undefined. */
function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…[truncated]` : trimmed;
}

/** Keep the one-line log parseable: strip newlines/quotes that would break the `key="value"` shape. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
}

/**
 * POST /api/client-error (ADR 0078) — the browser reports an unexpected error and it lands in the SERVER
 * log, greppable, so a phone or a Docker Hub deployment with no dev console is not a black box.
 *
 * @Public (errors happen before login), CSRF-checked like any mutation (the SPA's report is same-origin),
 * SIZE-CAPPED (413 over 16 KB, fields truncated), and RATE-LIMITED per IP (429). It writes to the log
 * ONLY — no DB, no state — so its whole blast radius is a few log lines.
 */
@Public()
@Controller('client-error')
export class ClientErrorController {
  private readonly logger = new Logger('ClientError');

  constructor(@Inject(CLIENT_ERROR_LIMITER) private readonly limiter: RateLimiter) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  report(@Body() body: ClientErrorBody, @Req() req: ClientErrorRequest): void {
    // Size cap first — measure the actual payload, so it holds even without a Content-Length header.
    if (Buffer.byteLength(JSON.stringify(body ?? {})) > MAX_BODY_BYTES) {
      throw new PayloadTooLargeException('client-error payload too large');
    }

    // Rate limit — the backstop to the client-side dedupe. Keyed by the real client IP (trust proxy).
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    if (!this.limiter.allow(ip, Date.now())) {
      throw new HttpException('Too many client-error reports', HttpStatus.TOO_MANY_REQUESTS);
    }

    const message = clean(body.message, MAX_FIELD);
    if (message === undefined) {
      throw new BadRequestException('message is required');
    }
    const view = clean(body.view, 200) ?? 'unknown';
    const version = clean(body.appVersion, 40) ?? 'unknown';
    const ua = clean(body.userAgent, MAX_FIELD) ?? clean(firstHeader(req.headers['user-agent']), MAX_FIELD) ?? 'unknown';
    const timestamp = clean(body.timestamp, 40);
    const stack = clean(body.stack, MAX_FIELD);

    // ONE greppable line; the stack (if any) follows on its own line.
    this.logger.warn(
      `[client-error] view=${oneLine(view)} v=${oneLine(version)} ua="${oneLine(ua)}" msg="${oneLine(message)}"` +
        (timestamp ? ` ts=${oneLine(timestamp)}` : ''),
    );
    if (stack) this.logger.warn(`[client-error] stack: ${oneLine(stack)}`);
  }
}

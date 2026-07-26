import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

/**
 * The account is locked (ADR 0076): too many failed logins, so this attempt is refused with 429
 * regardless of the password. Carries the whole-seconds Retry-After the filter emits as a header.
 */
export class LockedException extends HttpException {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Locked', retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Only the response bits we touch — avoids depending on @types/express. */
interface ResponseLike {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

/** Emits the Retry-After header (seconds) alongside the 429 body — a client can back off precisely. */
@Catch(LockedException)
export class LockedExceptionFilter implements ExceptionFilter {
  catch(exception: LockedException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ResponseLike>();
    res.setHeader('Retry-After', String(exception.retryAfterSeconds));
    res.status(HttpStatus.TOO_MANY_REQUESTS).json(exception.getResponse());
  }
}

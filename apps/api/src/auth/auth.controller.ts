import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  clearSessionCookie,
  type HttpRequestLike,
  type HttpResponseLike,
  isHttps,
  readSessionToken,
  setSessionCookie,
} from './cookie';
import { Public } from './public.decorator';

interface SetupBody {
  username?: unknown;
  password?: unknown;
}
interface LoginBody extends SetupBody {
  trusted?: unknown;
}

function requireCredentials(body: SetupBody): { username: string; password: string } {
  const { username, password } = body;
  if (typeof username !== 'string' || username.length === 0) {
    throw new BadRequestException('username is required');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new BadRequestException('password is required');
  }
  return { username, password };
}

/**
 * /api/auth/* — the auth surface (ADR 0076). The whole controller is @Public: the global session guard
 * lets these through, because you cannot present a session before you have logged in. Cookies are set
 * with @Res({ passthrough: true }) so Nest still serializes the returned body.
 */
@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** The web app calls this on load to choose setup screen / login screen / the app itself. */
  @Get('status')
  async status(@Req() req: HttpRequestLike): Promise<{ needsSetup: boolean; authenticated: boolean }> {
    const session = await this.auth.validateSession(readSessionToken(req));
    return { needsSetup: await this.auth.needsSetup(), authenticated: session !== null };
  }

  /** Create the single account (first run only) and auto-login. A second attempt → 409 (closed forever). */
  @Post('setup')
  @HttpCode(200)
  async setup(
    @Body() body: LoginBody,
    @Req() req: HttpRequestLike,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<{ ok: true }> {
    const { username, password } = requireCredentials(body);
    const grant = await this.auth.setup(username, password, body.trusted === true);
    setSessionCookie(res, grant.token, grant.trusted, isHttps(req));
    return { ok: true };
  }

  /** Correct credentials → 200 + session cookie; wrong → 401. No lockout counting yet (step 4). */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Req() req: HttpRequestLike,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<{ ok: true }> {
    const { username, password } = requireCredentials(body);
    const grant = await this.auth.login(username, password, body.trusted === true);
    setSessionCookie(res, grant.token, grant.trusted, isHttps(req));
    return { ok: true };
  }

  /** Revoke the current session (delete the row) and clear the cookie. */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: HttpRequestLike,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<{ ok: true }> {
    await this.auth.logout(readSessionToken(req));
    clearSessionCookie(res);
    return { ok: true };
  }
}

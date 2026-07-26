import { BadRequestException, Body, Controller, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { type HttpRequestLike, readSessionToken } from './cookie';

interface ChangePasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

/**
 * Authenticated account actions (ADR 0076). Deliberately NOT @Public — unlike the auth front door,
 * these sit BEHIND the global session guard: you must already be logged in to change your password.
 */
@Controller('auth')
export class AccountController {
  constructor(private readonly auth: AuthService) {}

  /** Change the password; revokes every OTHER session, keeps this one (see AuthService.changePassword). */
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: ChangePasswordBody, @Req() req: HttpRequestLike): Promise<{ ok: true }> {
    const { currentPassword, newPassword } = body;
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      throw new BadRequestException('currentPassword is required');
    }
    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      throw new BadRequestException('newPassword is required');
    }
    const token = readSessionToken(req);
    if (token === undefined) throw new UnauthorizedException(); // the guard already ensured a session
    await this.auth.changePassword(token, currentPassword, newPassword);
    return { ok: true };
  }
}

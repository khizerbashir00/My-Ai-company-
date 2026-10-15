import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Public, ReqContext, RequestContext } from '../common/auth.decorators';
import { AUTH_COOKIE } from './auth.constants';
import { ChangePasswordDto, LoginDto } from './auth.dto';
import { AuthService, durationToMs } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Sets an httpOnly, SameSite=Strict session cookie. The token is never exposed to page scripts. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @ReqContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.login(dto.email, dto.password, ctx);
    res.cookie(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.isProduction,
      path: '/',
      maxAge: durationToMs(this.config.jwtExpiresIn),
    });
    return { user };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: this.config.isProduction });
    await this.audit.record({ actorType: 'USER', actorUserId: user.id, action: 'auth.logout', entityType: 'user', entityId: user.id, ctx });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { user };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @ReqContext() ctx: RequestContext) {
    await this.auth.changePassword(user, dto.currentPassword, dto.newPassword, ctx);
    return { ok: true };
  }
}

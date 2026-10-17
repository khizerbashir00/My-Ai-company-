import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthUser, CurrentUser, Public, ReqContext, RequestContext, Roles } from '../common/auth.decorators';
import type { SocialPlatform } from '../generated/prisma/client';
import { parsePlatformParam } from './providers';
import { SocialService } from './social.service';

export class StartConnectDto {
  @IsOptional()
  @IsBoolean()
  connectAll?: boolean;
}

function platformOr404(raw: string): SocialPlatform {
  const p = parsePlatformParam(raw);
  if (!p) throw new NotFoundException('Unknown platform. Supported: linkedin, facebook, reddit, x.');
  return p;
}

@Controller('social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  /** Connection status for every supported platform. Booleans, names and scopes only — never tokens or secrets. */
  @Get('connections')
  async list() {
    return { platforms: await this.social.statusAll(), encryption: this.social.encryptionSource };
  }

  /** Starts OAuth: returns the platform's official authorization URL. CEO only. */
  @Roles('CEO')
  @Post(':platform/connect')
  @HttpCode(200)
  connect(@Param('platform') raw: string, @Body() dto: StartConnectDto, @CurrentUser() user: AuthUser) {
    return this.social.startConnect(platformOr404(raw), user, { connectAll: dto.connectAll });
  }

  /**
   * OAuth redirect target registered with each platform. Public by necessity (the session cookie is
   * SameSite=Strict and is not sent on cross-site redirects); the single-use state authenticates it.
   */
  @Public()
  @Get(':platform/callback')
  async callback(@Param('platform') raw: string, @Query() query: Record<string, unknown>, @ReqContext() ctx: RequestContext, @Res() res: Response) {
    const platform = parsePlatformParam(raw);
    if (!platform) {
      res.status(404).json({ statusCode: 404, error: 'NOT_FOUND', message: 'Unknown platform.' });
      return;
    }
    const { redirectTo } = await this.social.handleCallback(platform, query, ctx);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, redirectTo);
  }

  /** Live test: calls the platform's identity endpoint with the stored (refreshed if needed) token. */
  @Roles('CEO', 'ADMIN')
  @Post(':platform/verify')
  @HttpCode(200)
  verify(@Param('platform') raw: string, @CurrentUser() user: AuthUser) {
    return this.social.verify(platformOr404(raw), user);
  }

  /** Revokes at the provider where supported and deletes the stored tokens. CEO only. */
  @Roles('CEO')
  @Post(':platform/disconnect')
  @HttpCode(200)
  disconnect(@Param('platform') raw: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.social.disconnect(platformOr404(raw), user, ctx);
  }
}

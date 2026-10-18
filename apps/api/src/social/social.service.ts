import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { SocialAccount, SocialPlatform } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { TokenCipher } from '../common/token-cipher';
import { AppConfigService } from '../config/app-config.service';
import { ControlLogService } from '../control/control-core';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SOCIAL_PLATFORM_ORDER,
  SOCIAL_PROVIDERS,
  SocialProviderError,
  type ProviderContext,
  type SocialProvider,
  type TokenSet,
} from './providers';
import { SOCIAL_HTTP, type SocialHttp } from './social-http';

const STATE_TTL_MS = 10 * 60_000;
/** Refresh access tokens this long before they expire */
const REFRESH_SKEW_MS = 2 * 60_000;
const DEFAULT_GRAPH_VERSION = 'v26.0';

export type SocialStatus = 'NOT_CONFIGURED' | 'NOT_CONNECTED' | 'CONNECTED' | 'EXPIRED' | 'ERROR';

export interface SocialPlatformStatus {
  platform: SocialPlatform;
  name: string;
  status: SocialStatus;
  configured: boolean;
  /** Env var names that still need values (never the values) */
  missing: string[];
  redirectUri: string;
  requestedScopes: string[];
  grantedScopes: string[];
  account: { externalAccountId: string; displayName: string; profileUrl: string | null; metadata: unknown } | null;
  connectedAt: string | null;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  supportsRefresh: boolean;
  hasRefreshToken: boolean;
  usesPkce: boolean;
  developerConsoleUrl: string;
  docsUrl: string;
  setupNotes: string[];
}

export type CallbackOutcome = { platform: string; result: 'connected' } | { platform: string; result: 'error'; reason: string };

@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);
  private readonly cipher: TokenCipher;
  private readonly refreshing = new Map<SocialPlatform, Promise<string | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly controlLog: ControlLogService,
    private readonly events: EventsService,
    @Inject(SOCIAL_HTTP) private readonly http: SocialHttp,
  ) {
    this.cipher = TokenCipher.fromConfig({
      tokenKeyB64: config.socialEnv('TOKEN_ENCRYPTION_KEY'),
      jwtSecret: config.jwtSecret,
      isProduction: config.isProduction,
    });
    if (this.cipher.source === 'derived-dev') {
      this.logger.warn('TOKEN_ENCRYPTION_KEY not set — using a key derived from JWT_SECRET (development only).');
    }
  }

  get encryptionSource(): TokenCipher['source'] {
    return this.cipher.source;
  }

  // ───────────────────────────── status ─────────────────────────────

  redirectUri(platform: SocialPlatform): string {
    return `${this.config.publicAppUrl}/api/social/${platform.toLowerCase()}/callback`;
  }

  private requestedScopes(p: SocialProvider): string[] {
    const raw = this.config.socialEnv(p.scopesEnv as Parameters<AppConfigService['socialEnv']>[0]);
    if (!raw) return p.defaultScopes;
    return raw.split(p.scopeSeparator === ',' ? /[,\s]+/ : /\s+/).filter(Boolean);
  }

  private missingConfig(p: SocialProvider): string[] {
    const missing: string[] = [];
    if (!this.config.socialEnv(p.clientIdEnv as Parameters<AppConfigService['socialEnv']>[0])) missing.push(p.clientIdEnv);
    if (!this.config.socialEnv(p.clientSecretEnv as Parameters<AppConfigService['socialEnv']>[0])) missing.push(p.clientSecretEnv);
    if (!this.cipher.available) missing.push('TOKEN_ENCRYPTION_KEY');
    return missing;
  }

  private creds(p: SocialProvider) {
    const clientId = this.config.socialEnv(p.clientIdEnv as Parameters<AppConfigService['socialEnv']>[0]);
    const clientSecret = this.config.socialEnv(p.clientSecretEnv as Parameters<AppConfigService['socialEnv']>[0]);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  private ctx(p: SocialProvider): ProviderContext {
    const creds = this.creds(p);
    if (!creds) throw new ServiceUnavailableException(`${p.name} is not configured on the server (${p.clientIdEnv} / ${p.clientSecretEnv}).`);
    return {
      http: this.http,
      creds,
      userAgent: this.config.socialEnv('REDDIT_USER_AGENT') ?? 'ai-company-hq/0.2 (CEO social connections)',
      graphVersion: this.config.socialEnv('FACEBOOK_GRAPH_VERSION') ?? DEFAULT_GRAPH_VERSION,
    };
  }

  async statusAll(): Promise<SocialPlatformStatus[]> {
    const rows = await this.prisma.socialAccount.findMany();
    return SOCIAL_PLATFORM_ORDER.map((platform) => this.toStatus(platform, rows.find((r) => r.platform === platform) ?? null));
  }

  private toStatus(platform: SocialPlatform, row: SocialAccount | null): SocialPlatformStatus {
    const p = SOCIAL_PROVIDERS[platform];
    const missing = this.missingConfig(p);
    let status: SocialStatus;
    if (row) {
      const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now() && !row.refreshTokenEnc;
      status = row.status === 'CONNECTED' && expired ? 'EXPIRED' : row.status;
    } else {
      status = missing.length ? 'NOT_CONFIGURED' : 'NOT_CONNECTED';
    }
    return {
      platform,
      name: p.name,
      status,
      configured: missing.length === 0,
      missing,
      redirectUri: this.redirectUri(platform),
      requestedScopes: this.requestedScopes(p),
      grantedScopes: row?.scopes ?? [],
      account: row
        ? { externalAccountId: row.externalAccountId, displayName: row.displayName, profileUrl: row.profileUrl, metadata: row.metadata }
        : null,
      connectedAt: row?.connectedAt.toISOString() ?? null,
      expiresAt: row?.expiresAt?.toISOString() ?? null,
      lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
      lastRefreshedAt: row?.lastRefreshedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      supportsRefresh: p.supportsRefresh,
      hasRefreshToken: Boolean(row?.refreshTokenEnc),
      usesPkce: p.usesPkce,
      developerConsoleUrl: p.developerConsoleUrl,
      docsUrl: p.docsUrl,
      setupNotes: p.setupNotes,
    };
  }

  // ───────────────────────────── connect ─────────────────────────────

  /** Creates a single-use state (and PKCE verifier) and returns the platform's official authorization URL. */
  async startConnect(platform: SocialPlatform, user: AuthUser, opts: { connectAll?: boolean } = {}) {
    const p = SOCIAL_PROVIDERS[platform];
    const missing = this.missingConfig(p);
    if (missing.length) {
      throw new BadRequestException(`${p.name} is not configured on the server. Set ${missing.join(', ')} and restart the API.`);
    }
    const creds = this.creds(p)!;

    // Housekeeping: expired states are useless.
    await this.prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const state = randomBytes(32).toString('base64url');
    let codeVerifier: string | null = null;
    let codeChallenge: string | undefined;
    if (p.usesPkce) {
      codeVerifier = randomBytes(48).toString('base64url');
      codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    }
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await this.prisma.oAuthState.create({
      data: {
        stateHash: sha256(state),
        platform,
        userId: user.id,
        codeVerifierEnc: codeVerifier ? this.cipher.encrypt(codeVerifier) : null,
        connectAll: Boolean(opts.connectAll),
        expiresAt,
      },
    });

    const authorizationUrl = p.authorizeUrl({
      clientId: creds.clientId,
      redirectUri: this.redirectUri(platform),
      state,
      scopes: this.requestedScopes(p),
      codeChallenge,
      graphVersion: this.config.socialEnv('FACEBOOK_GRAPH_VERSION') ?? DEFAULT_GRAPH_VERSION,
    });
    await this.controlLog.log({ action: 'social.connect_started', message: `${p.name} authorization started.`, data: { platform }, actorUserId: user.id });
    return { platform, authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Handles the provider redirect. Public route: the SameSite=Strict session cookie is not sent on a
   * cross-site redirect, so the caller is identified by the single-use state instead.
   * Returns where to send the browser — always our own app, never a URL from the request.
   */
  async handleCallback(platform: SocialPlatform, query: Record<string, unknown>, ctx: RequestContext): Promise<{ redirectTo: string; outcome: CallbackOutcome }> {
    const p = SOCIAL_PROVIDERS[platform];
    const slug = platform.toLowerCase();
    const finish = (outcome: CallbackOutcome, connectAll: boolean) => {
      const u = new URL('/control', this.config.publicAppUrl);
      u.searchParams.set('social', slug);
      u.searchParams.set('result', outcome.result);
      if (outcome.result === 'error') u.searchParams.set('reason', outcome.reason);
      if (connectAll && outcome.result === 'connected') u.searchParams.set('connectAll', '1');
      return { redirectTo: u.toString(), outcome };
    };

    const state = typeof query.state === 'string' ? query.state : '';
    if (!state || state.length > 200) return finish({ platform: slug, result: 'error', reason: 'invalid_state' }, false);

    // Atomically consume the state: valid, unexpired, for this platform, not used before.
    const now = new Date();
    const stateHash = sha256(state);
    const claimed = await this.prisma.oAuthState.updateMany({
      where: { stateHash, platform, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    const row = await this.prisma.oAuthState.findUnique({ where: { stateHash } });
    if (claimed.count !== 1 || !row) {
      const reason = row && row.platform === platform && !row.consumedAt ? 'expired_state' : 'invalid_state';
      await this.controlLog.log({ level: 'WARN', action: 'social.callback_rejected', message: `${p.name} callback rejected (${reason}).`, data: { platform, reason } });
      return finish({ platform: slug, result: 'error', reason }, false);
    }

    const fail = async (reason: string, detail: string) => {
      await this.controlLog.log({ level: 'ERROR', action: 'social.connect_failed', message: `${p.name}: ${detail}`, data: { platform, reason }, actorUserId: row.userId });
      return finish({ platform: slug, result: 'error', reason }, false);
    };

    if (typeof query.error === 'string') {
      const reason = query.error === 'access_denied' || query.error === 'user_cancelled_authorize' || query.error === 'user_cancelled_login' ? 'denied' : 'provider_error';
      return fail(reason, `authorization was not granted (${String(query.error).slice(0, 60)}).`);
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || code.length > 2000) return fail('missing_code', 'the callback did not include an authorization code.');

    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, role: true, isActive: true } });
    if (!user?.isActive || user.role !== 'CEO') return fail('not_allowed', 'the user who started this connection can no longer connect accounts.');
    if (this.missingConfig(p).length) return fail('not_configured', 'server configuration changed during authorization.');

    let tokens: TokenSet;
    let profile;
    try {
      const pctx = this.ctx(p);
      const codeVerifier = row.codeVerifierEnc ? this.cipher.decrypt(row.codeVerifierEnc) : null;
      tokens = await p.exchangeCode(pctx, { code, redirectUri: this.redirectUri(platform), codeVerifier });
      profile = await p.fetchProfile(pctx, tokens.accessToken);
    } catch (err) {
      const msg = err instanceof SocialProviderError ? err.message : 'could not reach the provider.';
      if (!(err instanceof SocialProviderError)) this.logger.warn(`${p.name} callback error: ${err instanceof Error ? err.name : 'unknown'}`);
      return fail('exchange_failed', msg);
    }

    const scopes = profile.grantedScopes?.length ? profile.grantedScopes : tokens.scopes?.length ? tokens.scopes : this.requestedScopes(p);
    const data = {
      status: 'CONNECTED' as const,
      externalAccountId: profile.id,
      displayName: profile.displayName.slice(0, 200),
      profileUrl: profile.profileUrl ?? null,
      scopes,
      accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? this.cipher.encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
      refreshExpiresAt: tokens.refreshExpiresIn ? new Date(Date.now() + tokens.refreshExpiresIn * 1000) : null,
      metadata: profile.metadata ? (profile.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
      connectedById: user.id,
      connectedAt: new Date(),
      lastVerifiedAt: new Date(),
      lastRefreshedAt: null,
      lastError: null,
    };
    await this.prisma.socialAccount.upsert({ where: { platform }, create: { platform, ...data }, update: data });

    await this.audit.record({
      actorType: 'USER',
      actorUserId: user.id,
      action: 'social.connected',
      entityType: 'social_account',
      entityId: platform,
      data: { platform, account: profile.displayName, scopes },
      ctx,
    });
    await this.controlLog.log({
      action: 'social.connected',
      message: `${p.name} connected as ${profile.displayName}.`,
      data: { platform, scopes },
      actorUserId: user.id,
    });
    this.events.emit({ type: 'social.updated', platform });
    return finish({ platform: slug, result: 'connected' }, row.connectAll);
  }

  // ───────────────────────────── tokens ─────────────────────────────

  /**
   * A usable access token for server-side calls, refreshing when it is about to expire.
   * Returns null when the platform is not connected or the token can no longer be refreshed.
   */
  async getValidAccessToken(platform: SocialPlatform): Promise<string | null> {
    const inFlight = this.refreshing.get(platform);
    if (inFlight) return inFlight;
    const work = this.resolveToken(platform).finally(() => this.refreshing.delete(platform));
    this.refreshing.set(platform, work);
    return work;
  }

  private async resolveToken(platform: SocialPlatform): Promise<string | null> {
    if (!this.cipher.available) return null;
    const row = await this.prisma.socialAccount.findUnique({ where: { platform } });
    if (!row || row.status === 'EXPIRED') return null;
    const fresh = row.expiresAt === null || row.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS;
    if (fresh) return this.cipher.decrypt(row.accessTokenEnc);

    const p = SOCIAL_PROVIDERS[platform];
    if (!row.refreshTokenEnc || !p.refresh || !this.creds(p)) {
      await this.markProblem(platform, 'EXPIRED', 'Access token expired. Reconnect to continue.');
      return null;
    }
    try {
      const t = await p.refresh(this.ctx(p), this.cipher.decrypt(row.refreshTokenEnc));
      await this.prisma.socialAccount.update({
        where: { platform },
        data: {
          status: 'CONNECTED',
          accessTokenEnc: this.cipher.encrypt(t.accessToken),
          // Some providers rotate refresh tokens; keep the old one when they don't send a new one.
          ...(t.refreshToken ? { refreshTokenEnc: this.cipher.encrypt(t.refreshToken) } : {}),
          expiresAt: t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000) : null,
          lastRefreshedAt: new Date(),
          lastError: null,
        },
      });
      await this.controlLog.log({ action: 'social.token_refreshed', message: `${p.name} access token refreshed.`, data: { platform } });
      this.events.emit({ type: 'social.updated', platform });
      return t.accessToken;
    } catch (err) {
      const msg = err instanceof SocialProviderError ? err.message : 'Token refresh failed.';
      const revoked = err instanceof SocialProviderError && (err.providerCode === 'invalid_grant' || err.status === 400 || err.status === 401);
      await this.markProblem(platform, revoked ? 'EXPIRED' : 'ERROR', revoked ? `${msg} Reconnect to continue.` : msg);
      return null;
    }
  }

  private async markProblem(platform: SocialPlatform, status: 'EXPIRED' | 'ERROR', message: string): Promise<void> {
    await this.prisma.socialAccount.update({ where: { platform }, data: { status, lastError: message.slice(0, 500) } }).catch(() => undefined);
    await this.controlLog.log({ level: status === 'ERROR' ? 'ERROR' : 'WARN', action: `social.${status.toLowerCase()}`, message: `${SOCIAL_PROVIDERS[platform].name}: ${message}`, data: { platform } });
    this.events.emit({ type: 'social.updated', platform });
  }

  // ───────────────────────────── verify / disconnect ─────────────────────────────

  /** Calls the platform's identity endpoint with the stored token — a real end-to-end connection test. */
  async verify(platform: SocialPlatform, user: AuthUser): Promise<SocialPlatformStatus> {
    const p = SOCIAL_PROVIDERS[platform];
    const row = await this.prisma.socialAccount.findUnique({ where: { platform } });
    if (!row) throw new NotFoundException(`${p.name} is not connected.`);
    if (!this.creds(p) || !this.cipher.available) throw new ServiceUnavailableException(`${p.name} is not configured on the server.`);

    const token = await this.getValidAccessToken(platform);
    if (token) {
      try {
        const profile = await p.fetchProfile(this.ctx(p), token);
        await this.prisma.socialAccount.update({
          where: { platform },
          data: {
            status: 'CONNECTED',
            displayName: profile.displayName.slice(0, 200),
            profileUrl: profile.profileUrl ?? null,
            ...(profile.metadata ? { metadata: profile.metadata as Prisma.InputJsonValue } : {}),
            ...(profile.grantedScopes?.length ? { scopes: profile.grantedScopes } : {}),
            lastVerifiedAt: new Date(),
            lastError: null,
          },
        });
        await this.controlLog.log({ action: 'social.verified', message: `${p.name} connection verified (${profile.displayName}).`, data: { platform }, actorUserId: user.id });
      } catch (err) {
        const msg = err instanceof SocialProviderError ? err.message : 'Could not reach the provider.';
        const authFailure = err instanceof SocialProviderError && (err.status === 401 || err.status === 403);
        await this.markProblem(platform, authFailure ? 'EXPIRED' : 'ERROR', authFailure ? `${msg} Reconnect to continue.` : msg);
      }
    }
    this.events.emit({ type: 'social.updated', platform });
    const fresh = await this.prisma.socialAccount.findUnique({ where: { platform } });
    return this.toStatus(platform, fresh);
  }

  async disconnect(platform: SocialPlatform, user: AuthUser, ctx: RequestContext): Promise<{ platform: SocialPlatform; revokedAtProvider: boolean }> {
    const p = SOCIAL_PROVIDERS[platform];
    const row = await this.prisma.socialAccount.findUnique({ where: { platform } });
    if (!row) throw new NotFoundException(`${p.name} is not connected.`);

    let revokedAtProvider = false;
    if (p.revoke && this.creds(p) && this.cipher.available) {
      try {
        await p.revoke(this.ctx(p), {
          accessToken: this.cipher.decrypt(row.accessTokenEnc),
          refreshToken: row.refreshTokenEnc ? this.cipher.decrypt(row.refreshTokenEnc) : null,
        });
        revokedAtProvider = true;
      } catch (err) {
        this.logger.warn(`${p.name} revoke failed: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    await this.prisma.socialAccount.delete({ where: { platform } });
    await this.audit.record({ actorType: 'USER', actorUserId: user.id, action: 'social.disconnected', entityType: 'social_account', entityId: platform, data: { platform, revokedAtProvider }, ctx });
    await this.controlLog.log({
      level: revokedAtProvider || !p.revoke ? 'INFO' : 'WARN',
      action: 'social.disconnected',
      message: `${p.name} disconnected; stored tokens deleted${p.revoke ? (revokedAtProvider ? ' and revoked at the provider' : ' (provider revoke failed — remove the app from your account settings too)') : ''}.`,
      data: { platform, revokedAtProvider },
      actorUserId: user.id,
    });
    this.events.emit({ type: 'social.updated', platform });
    return { platform, revokedAtProvider };
  }

  /** Platforms that are configured on the server but not currently connected (Connect All walks these). */
  async pendingConnections(): Promise<SocialPlatform[]> {
    const statuses = await this.statusAll();
    return statuses.filter((s) => s.configured && s.status !== 'CONNECTED').map((s) => s.platform);
  }
}

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

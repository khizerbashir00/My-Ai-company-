import { createHmac } from 'node:crypto';
import type { SocialPlatform } from '../generated/prisma/client';
import type { SocialHttp, SocialHttpResponse } from './social-http';

/**
 * Official OAuth 2.0 authorization-code flows for each supported platform.
 * Endpoints are the providers' documented ones; nothing here scrapes or uses passwords.
 *
 * - LinkedIn: https://learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow
 * - Facebook: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 * - Reddit:   https://github.com/reddit-archive/reddit/wiki/OAuth2
 * - X:        https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
 */

export class SocialProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Short provider error code (e.g. invalid_grant) — never tokens or full bodies */
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'SocialProviderError';
  }
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** Seconds until the access token expires */
  expiresIn?: number | null;
  refreshExpiresIn?: number | null;
  scopes?: string[] | null;
}

export interface SocialProfile {
  id: string;
  displayName: string;
  profileUrl?: string | null;
  /** Non-secret extras stored for display (e.g. Facebook page names) */
  metadata?: Record<string, unknown>;
  /** Scopes the provider reports as granted, when it can tell us */
  grantedScopes?: string[];
}

export interface ProviderContext {
  http: SocialHttp;
  creds: ClientCredentials;
  /** Reddit requires a descriptive User-Agent on every call */
  userAgent: string;
  /** Facebook Graph API version (v26.0) */
  graphVersion: string;
}

export interface SocialProvider {
  platform: SocialPlatform;
  name: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  scopesEnv: string;
  defaultScopes: string[];
  scopeSeparator: ' ' | ',';
  usesPkce: boolean;
  /** Whether the provider issues refresh tokens we can use without re-prompting */
  supportsRefresh: boolean;
  developerConsoleUrl: string;
  docsUrl: string;
  /** What the CEO must do on the platform side beyond setting env vars */
  setupNotes: string[];
  authorizeUrl(p: { clientId: string; redirectUri: string; state: string; scopes: string[]; codeChallenge?: string; graphVersion: string }): string;
  exchangeCode(ctx: ProviderContext, p: { code: string; redirectUri: string; codeVerifier?: string | null }): Promise<TokenSet>;
  refresh?(ctx: ProviderContext, refreshToken: string): Promise<TokenSet>;
  fetchProfile(ctx: ProviderContext, accessToken: string): Promise<SocialProfile>;
  revoke?(ctx: ProviderContext, tokens: { accessToken: string; refreshToken?: string | null }): Promise<void>;
}

// ───────────────────────────── helpers ─────────────────────────────

function basicAuth(creds: ClientCredentials): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(creds.clientId)}:${encodeURIComponent(creds.clientSecret)}`).toString('base64')}`;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Extracts a short, safe error code from provider error bodies. Never returns the body itself. */
function providerCode(json: unknown): string | undefined {
  const o = obj(json);
  const e = o.error;
  if (typeof e === 'string') return e.slice(0, 80);
  const fbErr = obj(e);
  if (typeof fbErr.type === 'string') return `${fbErr.type}${fbErr.code ? `:${String(fbErr.code)}` : ''}`.slice(0, 80);
  if (typeof o.title === 'string') return o.title.slice(0, 80);
  return undefined;
}

function ensureOk(res: SocialHttpResponse, what: string): Record<string, unknown> {
  if (res.status < 200 || res.status >= 300) {
    const code = providerCode(res.json);
    throw new SocialProviderError(`${what} failed (HTTP ${res.status}${code ? `, ${code}` : ''})`, res.status, code);
  }
  return obj(res.json);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseTokens(body: Record<string, unknown>, what: string, _requestSeparator: ' ' | ','): TokenSet {
  const accessToken = str(body.access_token);
  if (!accessToken) throw new SocialProviderError(`${what}: provider returned no access_token`, undefined, providerCode(body));
  const scope = str(body.scope);
  return {
    accessToken,
    refreshToken: str(body.refresh_token),
    expiresIn: num(body.expires_in),
    refreshExpiresIn: num(body.refresh_token_expires_in),
    // Providers are inconsistent (LinkedIn answers comma-separated even though you request space-separated).
    scopes: scope ? scope.split(/[,\s]+/).filter(Boolean) : null,
  };
}

function withQuery(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

// ───────────────────────────── LinkedIn ─────────────────────────────

const linkedin: SocialProvider = {
  platform: 'LINKEDIN',
  name: 'LinkedIn',
  clientIdEnv: 'LINKEDIN_CLIENT_ID',
  clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
  scopesEnv: 'LINKEDIN_SCOPES',
  defaultScopes: ['openid', 'profile', 'email', 'w_member_social'],
  scopeSeparator: ' ',
  usesPkce: false,
  supportsRefresh: true, // only for approved partner apps; otherwise reconnect every ~60 days
  developerConsoleUrl: 'https://www.linkedin.com/developers/apps',
  docsUrl: 'https://learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow',
  setupNotes: [
    'Create an app at linkedin.com/developers and verify it with your LinkedIn Page.',
    'Products tab: add "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn".',
    'Auth tab: add the redirect URL shown here exactly.',
    'Access tokens last ~60 days; programmatic refresh is limited to approved partners, so expect to reconnect.',
  ],
  authorizeUrl: ({ clientId, redirectUri, state, scopes }) =>
    withQuery('https://www.linkedin.com/oauth/v2/authorization', {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: scopes.join(' '),
    }),
  async exchangeCode(ctx, { code, redirectUri }) {
    const res = await ctx.http({
      method: 'POST',
      url: 'https://www.linkedin.com/oauth/v2/accessToken',
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: ctx.creds.clientId, client_secret: ctx.creds.clientSecret },
    });
    return parseTokens(ensureOk(res, 'LinkedIn token exchange'), 'LinkedIn token exchange', ' ');
  },
  async refresh(ctx, refreshToken) {
    const res = await ctx.http({
      method: 'POST',
      url: 'https://www.linkedin.com/oauth/v2/accessToken',
      form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: ctx.creds.clientId, client_secret: ctx.creds.clientSecret },
    });
    return parseTokens(ensureOk(res, 'LinkedIn token refresh'), 'LinkedIn token refresh', ' ');
  },
  async fetchProfile(ctx, accessToken) {
    const res = await ctx.http({ method: 'GET', url: 'https://api.linkedin.com/v2/userinfo', headers: { Authorization: `Bearer ${accessToken}` } });
    const body = ensureOk(res, 'LinkedIn profile');
    const id = str(body.sub);
    if (!id) throw new SocialProviderError('LinkedIn profile: missing member id (is the openid scope granted?)');
    const name = str(body.name) ?? [str(body.given_name), str(body.family_name)].filter(Boolean).join(' ');
    return { id, displayName: name || 'LinkedIn member', profileUrl: null, metadata: { email: str(body.email) } };
  },
  async revoke(ctx, { accessToken }) {
    await ctx.http({
      method: 'POST',
      url: 'https://www.linkedin.com/oauth/v2/revoke',
      form: { client_id: ctx.creds.clientId, client_secret: ctx.creds.clientSecret, token: accessToken },
    });
  },
};

// ───────────────────────────── Facebook ─────────────────────────────

/** Graph API "appsecret_proof" — proves calls come from the server holding the app secret. */
function appSecretProof(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

const facebook: SocialProvider = {
  platform: 'FACEBOOK',
  name: 'Facebook',
  clientIdEnv: 'FACEBOOK_APP_ID',
  clientSecretEnv: 'FACEBOOK_APP_SECRET',
  scopesEnv: 'FACEBOOK_SCOPES',
  defaultScopes: ['public_profile', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
  scopeSeparator: ',',
  usesPkce: false,
  supportsRefresh: false, // long-lived user tokens (~60 days) are re-issued by reconnecting
  developerConsoleUrl: 'https://developers.facebook.com/apps',
  docsUrl: 'https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow',
  setupNotes: [
    'Create a Business app at developers.facebook.com and add the "Facebook Login for Business" product.',
    'Add the redirect URL shown here under Valid OAuth Redirect URIs.',
    'pages_* permissions work for app admins/testers immediately; everyone else needs Meta App Review + Business Verification.',
    'Tokens are exchanged for long-lived (~60 day) tokens; reconnect before they expire.',
  ],
  authorizeUrl: ({ clientId, redirectUri, state, scopes, graphVersion }) =>
    withQuery(`https://www.facebook.com/${graphVersion}/dialog/oauth`, {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: scopes.join(','),
    }),
  async exchangeCode(ctx, { code, redirectUri }) {
    const base = `https://graph.facebook.com/${ctx.graphVersion}/oauth/access_token`;
    const shortRes = await ctx.http({
      method: 'GET',
      url: withQuery(base, { client_id: ctx.creds.clientId, client_secret: ctx.creds.clientSecret, redirect_uri: redirectUri, code }),
    });
    const short = parseTokens(ensureOk(shortRes, 'Facebook token exchange'), 'Facebook token exchange', ',');
    // Upgrade to a long-lived user token (~60 days) so the connection does not die after an hour.
    const longRes = await ctx.http({
      method: 'GET',
      url: withQuery(base, {
        grant_type: 'fb_exchange_token',
        client_id: ctx.creds.clientId,
        client_secret: ctx.creds.clientSecret,
        fb_exchange_token: short.accessToken,
      }),
    });
    if (longRes.status >= 200 && longRes.status < 300) {
      return parseTokens(obj(longRes.json), 'Facebook long-lived token', ',');
    }
    return short;
  },
  async fetchProfile(ctx, accessToken) {
    const proof = appSecretProof(accessToken, ctx.creds.clientSecret);
    const g = `https://graph.facebook.com/${ctx.graphVersion}`;
    const me = ensureOk(
      await ctx.http({ method: 'GET', url: withQuery(`${g}/me`, { fields: 'id,name', access_token: accessToken, appsecret_proof: proof }) }),
      'Facebook profile',
    );
    const id = str(me.id);
    if (!id) throw new SocialProviderError('Facebook profile: missing user id');

    // Granted permissions and manageable Pages are informative; failures here do not break the connection.
    let grantedScopes: string[] | undefined;
    const perms = await ctx.http({ method: 'GET', url: withQuery(`${g}/me/permissions`, { access_token: accessToken, appsecret_proof: proof }) });
    if (perms.status === 200) {
      const data = obj(perms.json).data;
      if (Array.isArray(data)) {
        grantedScopes = data.map(obj).filter((p) => p.status === 'granted').map((p) => String(p.permission));
      }
    }
    let pages: { id: string; name: string }[] = [];
    const acc = await ctx.http({ method: 'GET', url: withQuery(`${g}/me/accounts`, { fields: 'id,name', access_token: accessToken, appsecret_proof: proof }) });
    if (acc.status === 200) {
      const data = obj(acc.json).data;
      if (Array.isArray(data)) pages = data.map(obj).map((p) => ({ id: String(p.id), name: String(p.name ?? '') }));
    }
    return { id, displayName: str(me.name) ?? 'Facebook user', profileUrl: null, metadata: { pages }, grantedScopes };
  },
  async revoke(ctx, { accessToken }) {
    await ctx.http({
      method: 'DELETE',
      url: withQuery(`https://graph.facebook.com/${ctx.graphVersion}/me/permissions`, {
        access_token: accessToken,
        appsecret_proof: appSecretProof(accessToken, ctx.creds.clientSecret),
      }),
    });
  },
};

// ───────────────────────────── Reddit ─────────────────────────────

const reddit: SocialProvider = {
  platform: 'REDDIT',
  name: 'Reddit',
  clientIdEnv: 'REDDIT_CLIENT_ID',
  clientSecretEnv: 'REDDIT_CLIENT_SECRET',
  scopesEnv: 'REDDIT_SCOPES',
  defaultScopes: ['identity', 'read', 'submit'],
  scopeSeparator: ' ',
  usesPkce: false,
  supportsRefresh: true,
  developerConsoleUrl: 'https://www.reddit.com/prefs/apps',
  docsUrl: 'https://github.com/reddit-archive/reddit/wiki/OAuth2',
  setupNotes: [
    'Create a "web app" at reddit.com/prefs/apps (script apps cannot use this redirect flow) and set its redirect URI to the one shown here.',
    'Since Nov 2025 Reddit requires approval under its Responsible Builder Policy before new OAuth apps work — request access first.',
    'Once connected, the Reddit lead source scans with your authorization (refreshed automatically).',
  ],
  authorizeUrl: ({ clientId, redirectUri, state, scopes }) =>
    withQuery('https://www.reddit.com/api/v1/authorize', {
      client_id: clientId,
      response_type: 'code',
      state,
      redirect_uri: redirectUri,
      duration: 'permanent',
      scope: scopes.join(' '),
    }),
  async exchangeCode(ctx, { code, redirectUri }) {
    const res = await ctx.http({
      method: 'POST',
      url: 'https://www.reddit.com/api/v1/access_token',
      headers: { Authorization: basicAuth(ctx.creds), 'User-Agent': ctx.userAgent },
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    });
    const body = ensureOk(res, 'Reddit token exchange');
    if (typeof body.error === 'string') throw new SocialProviderError(`Reddit token exchange failed (${body.error})`, res.status, body.error);
    return parseTokens(body, 'Reddit token exchange', ' ');
  },
  async refresh(ctx, refreshToken) {
    const res = await ctx.http({
      method: 'POST',
      url: 'https://www.reddit.com/api/v1/access_token',
      headers: { Authorization: basicAuth(ctx.creds), 'User-Agent': ctx.userAgent },
      form: { grant_type: 'refresh_token', refresh_token: refreshToken },
    });
    const body = ensureOk(res, 'Reddit token refresh');
    if (typeof body.error === 'string') throw new SocialProviderError(`Reddit token refresh failed (${body.error})`, res.status, body.error);
    return parseTokens(body, 'Reddit token refresh', ' ');
  },
  async fetchProfile(ctx, accessToken) {
    const res = await ctx.http({
      method: 'GET',
      url: 'https://oauth.reddit.com/api/v1/me',
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': ctx.userAgent },
    });
    const body = ensureOk(res, 'Reddit profile');
    const id = str(body.id);
    const name = str(body.name);
    if (!id || !name) throw new SocialProviderError('Reddit profile: missing account id (is the identity scope granted?)');
    return { id, displayName: `u/${name}`, profileUrl: `https://www.reddit.com/user/${encodeURIComponent(name)}` };
  },
  async revoke(ctx, { accessToken, refreshToken }) {
    await ctx.http({
      method: 'POST',
      url: 'https://www.reddit.com/api/v1/revoke_token',
      headers: { Authorization: basicAuth(ctx.creds), 'User-Agent': ctx.userAgent },
      form: refreshToken ? { token: refreshToken, token_type_hint: 'refresh_token' } : { token: accessToken, token_type_hint: 'access_token' },
    });
  },
};

// ───────────────────────────── X ─────────────────────────────

const x: SocialProvider = {
  platform: 'X',
  name: 'X (Twitter)',
  clientIdEnv: 'X_CLIENT_ID',
  clientSecretEnv: 'X_CLIENT_SECRET',
  scopesEnv: 'X_SCOPES',
  defaultScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  scopeSeparator: ' ',
  usesPkce: true,
  supportsRefresh: true,
  developerConsoleUrl: 'https://developer.x.com/en/portal/dashboard',
  docsUrl: 'https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code',
  setupNotes: [
    'In the X developer portal, enable OAuth 2.0 user authentication with type "Web App" (confidential client).',
    'Add the callback URL shown here exactly; copy the OAuth 2.0 Client ID and Client Secret (not the API key).',
    'Posting and most reads need a paid X API access tier.',
  ],
  authorizeUrl: ({ clientId, redirectUri, state, scopes, codeChallenge }) =>
    withQuery('https://x.com/i/oauth2/authorize', {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }),
  async exchangeCode(ctx, { code, redirectUri, codeVerifier }) {
    if (!codeVerifier) throw new SocialProviderError('X token exchange: missing PKCE verifier');
    const res = await ctx.http({
      method: 'POST',
      url: 'https://api.x.com/2/oauth2/token',
      headers: { Authorization: basicAuth(ctx.creds) },
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: ctx.creds.clientId },
    });
    return parseTokens(ensureOk(res, 'X token exchange'), 'X token exchange', ' ');
  },
  async refresh(ctx, refreshToken) {
    const res = await ctx.http({
      method: 'POST',
      url: 'https://api.x.com/2/oauth2/token',
      headers: { Authorization: basicAuth(ctx.creds) },
      form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: ctx.creds.clientId },
    });
    return parseTokens(ensureOk(res, 'X token refresh'), 'X token refresh', ' ');
  },
  async fetchProfile(ctx, accessToken) {
    const res = await ctx.http({ method: 'GET', url: 'https://api.x.com/2/users/me', headers: { Authorization: `Bearer ${accessToken}` } });
    const data = obj(ensureOk(res, 'X profile').data);
    const id = str(data.id);
    const username = str(data.username);
    if (!id || !username) throw new SocialProviderError('X profile: missing user id (is users.read granted?)');
    return { id, displayName: `@${username}`, profileUrl: `https://x.com/${encodeURIComponent(username)}`, metadata: { name: str(data.name) } };
  },
  async revoke(ctx, { accessToken, refreshToken }) {
    await ctx.http({
      method: 'POST',
      url: 'https://api.x.com/2/oauth2/revoke',
      headers: { Authorization: basicAuth(ctx.creds) },
      form: refreshToken ? { token: refreshToken, token_type_hint: 'refresh_token' } : { token: accessToken, token_type_hint: 'access_token' },
    });
  },
};

export const SOCIAL_PROVIDERS: Record<SocialPlatform, SocialProvider> = {
  LINKEDIN: linkedin,
  FACEBOOK: facebook,
  REDDIT: reddit,
  X: x,
};

export const SOCIAL_PLATFORM_ORDER: SocialPlatform[] = ['LINKEDIN', 'FACEBOOK', 'REDDIT', 'X'];

export function parsePlatformParam(raw: string): SocialPlatform | null {
  const up = raw.trim().toUpperCase();
  return (SOCIAL_PLATFORM_ORDER as string[]).includes(up) ? (up as SocialPlatform) : null;
}

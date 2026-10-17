import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { ConnectorRegistry } from '../src/connectors/connector.registry';
import { PrismaService } from '../src/prisma/prisma.service';
import type { SocialHttp, SocialHttpRequest } from '../src/social/social-http';
import { SocialService } from '../src/social/social.service';
import { CEO, createTestApp, loginAgent, resetDatabase, VIEWER } from './helpers';

/**
 * Stands in for the four providers' OAuth endpoints, enforcing what the real ones enforce:
 * client id/secret, exact redirect URI, single-use codes, PKCE verifier (X), Basic auth (Reddit/X).
 */
class FakeProviders {
  calls: SocialHttpRequest[] = [];
  /** code -> what was authorized */
  codes = new Map<string, { platform: string; redirectUri: string; challenge?: string }>();
  xRefreshCount = 0;

  issue(platform: string, authorizationUrl: string, code = `${platform}-code-${Math.random().toString(36).slice(2)}`) {
    const u = new URL(authorizationUrl);
    this.codes.set(code, {
      platform,
      redirectUri: u.searchParams.get('redirect_uri')!,
      challenge: u.searchParams.get('code_challenge') ?? undefined,
    });
    return { code, state: u.searchParams.get('state')! };
  }

  http: SocialHttp = async (req) => {
    this.calls.push(req);
    const url = new URL(req.url);
    const form = req.form ?? {};
    const basicOk = (id: string, secret: string) =>
      req.headers?.Authorization === `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    const takeCode = (platform: string, code: string | null, redirectUri: string | null) => {
      const c = code ? this.codes.get(code) : undefined;
      if (!c || c.platform !== platform || c.redirectUri !== redirectUri) return null;
      this.codes.delete(code!); // single use
      return c;
    };
    const bearer = req.headers?.Authorization?.replace(/^Bearer /, '');

    // LinkedIn
    if (url.href === 'https://www.linkedin.com/oauth/v2/accessToken') {
      if (form.client_id !== 'li-client' || form.client_secret !== 'li-secret') return { status: 401, json: { error: 'invalid_client' } };
      if (!takeCode('linkedin', form.code ?? null, form.redirect_uri ?? null)) return { status: 400, json: { error: 'invalid_grant' } };
      return { status: 200, json: { access_token: 'li-access-SECRET', expires_in: 5184000, scope: 'openid,profile,email,w_member_social' } };
    }
    if (url.href === 'https://api.linkedin.com/v2/userinfo') {
      return bearer === 'li-access-SECRET' ? { status: 200, json: { sub: 'li-member-1', name: 'Khizer Bashir', email: 'k@example.test' } } : { status: 401, json: {} };
    }
    if (url.href === 'https://www.linkedin.com/oauth/v2/revoke') return { status: 200, json: null };

    // Facebook (Graph v26.0)
    if (url.origin + url.pathname === 'https://graph.facebook.com/v26.0/oauth/access_token') {
      if (url.searchParams.get('client_secret') !== 'fb-secret') return { status: 400, json: { error: { type: 'OAuthException', code: 1 } } };
      if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
        return url.searchParams.get('fb_exchange_token') === 'fb-short-SECRET'
          ? { status: 200, json: { access_token: 'fb-long-SECRET', expires_in: 5_100_000 } }
          : { status: 400, json: { error: { type: 'OAuthException', code: 190 } } };
      }
      if (!takeCode('facebook', url.searchParams.get('code'), url.searchParams.get('redirect_uri'))) {
        return { status: 400, json: { error: { type: 'OAuthException', code: 100 } } };
      }
      return { status: 200, json: { access_token: 'fb-short-SECRET', expires_in: 3600 } };
    }
    if (url.origin === 'https://graph.facebook.com') {
      if (url.searchParams.get('access_token') !== 'fb-long-SECRET' || !url.searchParams.get('appsecret_proof')) {
        return { status: 401, json: { error: { type: 'OAuthException', code: 190 } } };
      }
      if (url.pathname === '/v26.0/me') return { status: 200, json: { id: 'fb-user-1', name: 'Khizer FB' } };
      if (url.pathname === '/v26.0/me/permissions' && req.method === 'GET') {
        return { status: 200, json: { data: [{ permission: 'public_profile', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'pages_show_list', status: 'declined' }] } };
      }
      if (url.pathname === '/v26.0/me/accounts') return { status: 200, json: { data: [{ id: 'page-1', name: 'HQ Web Studio' }] } };
      if (url.pathname === '/v26.0/me/permissions' && req.method === 'DELETE') return { status: 200, json: { success: true } };
    }

    // Reddit
    if (url.href === 'https://www.reddit.com/api/v1/access_token') {
      if (!basicOk('rd-client', 'rd-secret') || !req.headers?.['User-Agent']) return { status: 401, json: { error: 401 } };
      if (form.grant_type === 'refresh_token') {
        return form.refresh_token === 'rd-refresh-SECRET' ? { status: 200, json: { access_token: 'rd-access-2-SECRET', expires_in: 3600, scope: 'identity read submit' } } : { status: 400, json: { error: 'invalid_grant' } };
      }
      if (!takeCode('reddit', form.code ?? null, form.redirect_uri ?? null)) return { status: 200, json: { error: 'invalid_grant' } };
      return { status: 200, json: { access_token: 'rd-access-SECRET', refresh_token: 'rd-refresh-SECRET', expires_in: 3600, scope: 'identity read submit' } };
    }
    if (url.href === 'https://oauth.reddit.com/api/v1/me') {
      return bearer?.startsWith('rd-access') ? { status: 200, json: { id: 'rd1', name: 'hq_ceo' } } : { status: 401, json: {} };
    }
    if (url.href === 'https://www.reddit.com/api/v1/revoke_token') return { status: 204, json: null };

    // X
    if (url.href === 'https://api.x.com/2/oauth2/token') {
      if (!basicOk('x-client', 'x-secret')) return { status: 401, json: { error: 'unauthorized_client' } };
      if (form.grant_type === 'refresh_token') {
        if (form.refresh_token !== 'x-refresh-SECRET' && form.refresh_token !== 'x-refresh-2-SECRET') return { status: 400, json: { error: 'invalid_request' } };
        this.xRefreshCount += 1;
        return { status: 200, json: { access_token: 'x-access-2-SECRET', refresh_token: 'x-refresh-2-SECRET', expires_in: 7200, scope: 'tweet.read users.read tweet.write offline.access' } };
      }
      const c = form.code ? this.codes.get(form.code) : undefined;
      const verifierOk = c?.challenge && form.code_verifier && createHash('sha256').update(form.code_verifier).digest('base64url') === c.challenge;
      if (!verifierOk || !takeCode('x', form.code ?? null, form.redirect_uri ?? null)) return { status: 400, json: { error: 'invalid_request' } };
      return { status: 200, json: { access_token: 'x-access-SECRET', refresh_token: 'x-refresh-SECRET', expires_in: 7200, scope: 'tweet.read users.read tweet.write offline.access' } };
    }
    if (url.href === 'https://api.x.com/2/users/me') {
      return bearer?.startsWith('x-access') ? { status: 200, json: { data: { id: 'x-1', username: 'hq_ceo', name: 'HQ CEO' } } } : { status: 401, json: { title: 'Unauthorized' } };
    }
    if (url.href === 'https://api.x.com/2/oauth2/revoke') return { status: 200, json: { revoked: true } };

    return { status: 599, json: { error: `unexpected ${req.method} ${url.origin}${url.pathname}` } };
  };
}

const ENV: Record<string, string> = {
  PUBLIC_APP_URL: 'http://localhost:5173',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  LINKEDIN_CLIENT_ID: 'li-client',
  LINKEDIN_CLIENT_SECRET: 'li-secret',
  FACEBOOK_APP_ID: 'fb-app',
  FACEBOOK_APP_SECRET: 'fb-secret',
  REDDIT_CLIENT_ID: 'rd-client',
  REDDIT_CLIENT_SECRET: 'rd-secret',
  X_CLIENT_ID: 'x-client',
  X_CLIENT_SECRET: 'x-secret',
};

describe('Social OAuth connections (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const fake = new FakeProviders();
  let ceo: Awaited<ReturnType<typeof loginAgent>>;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    ({ app, prisma } = await createTestApp({ socialHttp: fake.http }));
  });

  afterAll(async () => {
    await app.close();
    for (const k of Object.keys(ENV)) process.env[k] = '';
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    fake.calls = [];
    ceo = await loginAgent(app, CEO);
  });

  /** Simulates the browser: start → consent (fake) → provider redirects to our callback without the session cookie. */
  async function connect(platform: 'linkedin' | 'facebook' | 'reddit' | 'x') {
    const start = await ceo.post(`/api/social/${platform}/connect`).send({}).expect(200);
    const { code, state } = fake.issue(platform, start.body.authorizationUrl);
    const cb = await request(app.getHttpServer()).get(`/api/social/${platform}/callback`).query({ code, state }).expect(302);
    return { start: start.body as { authorizationUrl: string }, location: cb.headers.location as string, state, code };
  }

  it('lists all four platforms without leaking secrets', async () => {
    const res = await ceo.get('/api/social/connections').expect(200);
    expect(res.body.platforms.map((p: { platform: string }) => p.platform)).toEqual(['LINKEDIN', 'FACEBOOK', 'REDDIT', 'X']);
    for (const p of res.body.platforms) {
      expect(p.status).toBe('NOT_CONNECTED');
      expect(p.configured).toBe(true);
      expect(p.redirectUri).toBe(`http://localhost:5173/api/social/${p.platform.toLowerCase()}/callback`);
    }
    const body = JSON.stringify(res.body);
    for (const secret of ['li-secret', 'fb-secret', 'rd-secret', 'x-secret', ENV.TOKEN_ENCRYPTION_KEY]) expect(body).not.toContain(secret);
  });

  it('builds official authorization URLs with state, exact redirect URI and scopes', async () => {
    const li = new URL((await ceo.post('/api/social/linkedin/connect').send({}).expect(200)).body.authorizationUrl);
    expect(li.origin + li.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(li.searchParams.get('client_id')).toBe('li-client');
    expect(li.searchParams.get('response_type')).toBe('code');
    expect(li.searchParams.get('scope')).toBe('openid profile email w_member_social');
    expect(li.searchParams.get('state')!.length).toBeGreaterThanOrEqual(40);

    const fb = new URL((await ceo.post('/api/social/facebook/connect').send({}).expect(200)).body.authorizationUrl);
    expect(fb.origin + fb.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(fb.searchParams.get('scope')).toBe('public_profile,pages_show_list,pages_read_engagement,pages_manage_posts');

    const rd = new URL((await ceo.post('/api/social/reddit/connect').send({}).expect(200)).body.authorizationUrl);
    expect(rd.origin + rd.pathname).toBe('https://www.reddit.com/api/v1/authorize');
    expect(rd.searchParams.get('duration')).toBe('permanent');

    const x = new URL((await ceo.post('/api/social/x/connect').send({}).expect(200)).body.authorizationUrl);
    expect(x.origin + x.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(x.searchParams.get('code_challenge_method')).toBe('S256');
    expect(x.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Only a hash of the state is stored.
    const rows = await prisma.oAuthState.findMany();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.stateHash)).not.toContain(li.searchParams.get('state'));
    expect(rows.find((r) => r.platform === 'X')!.codeVerifierEnc).toMatch(/^v1\./);
  });

  it('only the CEO can start or remove connections; viewers can read status', async () => {
    const viewer = await loginAgent(app, VIEWER);
    await viewer.post('/api/social/linkedin/connect').send({}).expect(403);
    await viewer.post('/api/social/linkedin/disconnect').send({}).expect(403);
    await viewer.post('/api/control/connect-all').send({}).expect(403);
    await viewer.get('/api/social/connections').expect(200);
    await request(app.getHttpServer()).post('/api/social/linkedin/connect').send({}).expect(401);
    await ceo.post('/api/social/myspace/connect').send({}).expect(404);
  });

  it('LinkedIn: full code flow stores encrypted tokens and reports CONNECTED', async () => {
    const { location } = await connect('linkedin');
    expect(location).toBe('http://localhost:5173/control?social=linkedin&result=connected');

    const row = await prisma.socialAccount.findUniqueOrThrow({ where: { platform: 'LINKEDIN' } });
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(row.accessTokenEnc).not.toContain('li-access');
    expect(row.externalAccountId).toBe('li-member-1');
    expect(row.connectedById).not.toBeNull();

    const status = (await ceo.get('/api/social/connections').expect(200)).body.platforms.find((p: { platform: string }) => p.platform === 'LINKEDIN');
    expect(status.status).toBe('CONNECTED');
    expect(status.account.displayName).toBe('Khizer Bashir');
    expect(status.grantedScopes).toContain('w_member_social');
    expect(JSON.stringify(status)).not.toContain('li-access-SECRET');

    // Live verify calls the identity endpoint with the decrypted token.
    const verified = await ceo.post('/api/social/linkedin/verify').send({}).expect(200);
    expect(verified.body.status).toBe('CONNECTED');
    expect(verified.body.lastVerifiedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: 'social.connected', entityId: 'LINKEDIN' } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.data)).not.toContain('SECRET');
  });

  it('rejects replayed, unknown and expired state, and user denial', async () => {
    const { state, code } = await connect('linkedin');
    // Replay of a consumed state
    let cb = await request(app.getHttpServer()).get('/api/social/linkedin/callback').query({ code, state }).expect(302);
    expect(cb.headers.location).toContain('result=error&reason=invalid_state');
    // Forged state
    cb = await request(app.getHttpServer()).get('/api/social/linkedin/callback').query({ code: 'x', state: 'forged-state-value' }).expect(302);
    expect(cb.headers.location).toContain('reason=invalid_state');
    // State minted for another platform cannot be used on this callback
    const startX = await ceo.post('/api/social/x/connect').send({}).expect(200);
    const xState = new URL(startX.body.authorizationUrl).searchParams.get('state')!;
    cb = await request(app.getHttpServer()).get('/api/social/linkedin/callback').query({ code: 'x', state: xState }).expect(302);
    expect(cb.headers.location).toContain('reason=invalid_state');
    // Expired state
    const start = await ceo.post('/api/social/reddit/connect').send({}).expect(200);
    const rdState = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    await prisma.oAuthState.updateMany({ where: { platform: 'REDDIT' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    cb = await request(app.getHttpServer()).get('/api/social/reddit/callback').query({ code: 'x', state: rdState }).expect(302);
    expect(cb.headers.location).toContain('reason=expired_state');
    // User clicks "Cancel" on the consent screen
    const fb = await ceo.post('/api/social/facebook/connect').send({}).expect(200);
    const fbState = new URL(fb.body.authorizationUrl).searchParams.get('state')!;
    cb = await request(app.getHttpServer()).get('/api/social/facebook/callback').query({ error: 'access_denied', state: fbState }).expect(302);
    expect(cb.headers.location).toBe('http://localhost:5173/control?social=facebook&result=error&reason=denied');
    expect(await prisma.socialAccount.count({ where: { platform: { in: ['FACEBOOK', 'REDDIT'] } } })).toBe(0);
    // Unknown platform on the callback
    await request(app.getHttpServer()).get('/api/social/myspace/callback').query({ state: 'x' }).expect(404);
  });

  it('reports a rejected code exchange as an error without storing anything', async () => {
    const start = await ceo.post('/api/social/linkedin/connect').send({}).expect(200);
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    const cb = await request(app.getHttpServer()).get('/api/social/linkedin/callback').query({ code: 'not-a-real-code', state }).expect(302);
    expect(cb.headers.location).toContain('reason=exchange_failed');
    expect(await prisma.socialAccount.count()).toBe(0);
    const ev = await prisma.controlEvent.findFirst({ where: { action: 'social.connect_failed' } });
    expect(ev?.level).toBe('ERROR');
    expect(ev?.message).toContain('invalid_grant');
  });

  it('X: PKCE flow, then refreshes an expiring token automatically', async () => {
    const { location } = await connect('x');
    expect(location).toContain('result=connected');
    const before = await prisma.socialAccount.findUniqueOrThrow({ where: { platform: 'X' } });
    expect(before.displayName).toBe('@hq_ceo');
    expect(before.refreshTokenEnc).toMatch(/^v1\./);

    await prisma.socialAccount.update({ where: { platform: 'X' }, data: { expiresAt: new Date(Date.now() + 30_000) } });
    const res = await ceo.post('/api/social/x/verify').send({}).expect(200);
    expect(res.body.status).toBe('CONNECTED');
    expect(fake.xRefreshCount).toBe(1);
    const after = await prisma.socialAccount.findUniqueOrThrow({ where: { platform: 'X' } });
    expect(after.lastRefreshedAt).not.toBeNull();
    expect(after.accessTokenEnc).not.toBe(before.accessTokenEnc);
    expect(after.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
  });

  it('Facebook: exchanges for a long-lived token and records pages and granted permissions', async () => {
    const { location } = await connect('facebook');
    expect(location).toContain('result=connected');
    expect(fake.calls.some((c) => c.url.includes('grant_type=fb_exchange_token'))).toBe(true);
    const row = await prisma.socialAccount.findUniqueOrThrow({ where: { platform: 'FACEBOOK' } });
    expect(row.scopes).toEqual(['public_profile', 'pages_manage_posts']); // declined permission excluded
    expect(row.metadata).toEqual({ pages: [{ id: 'page-1', name: 'HQ Web Studio' }] });
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 86_400_000);
  });

  it('Reddit: connected account feeds the Reddit lead-source connector, and disconnect revokes + deletes', async () => {
    await connect('reddit');
    const social = app.get(SocialService);
    expect(await social.getValidAccessToken('REDDIT')).toBe('rd-access-SECRET');

    // The lead connector's token source is wired to the connected account.
    const reddit = app.get(ConnectorRegistry).get('reddit') as unknown as { userTokenSource: () => Promise<string | null> };
    expect(await reddit.userTokenSource()).toBe('rd-access-SECRET');

    // Expired access token → refreshed with the stored refresh token.
    await prisma.socialAccount.update({ where: { platform: 'REDDIT' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await social.getValidAccessToken('REDDIT')).toBe('rd-access-2-SECRET');

    const res = await ceo.post('/api/social/reddit/disconnect').send({}).expect(200);
    expect(res.body.revokedAtProvider).toBe(true);
    expect(fake.calls.some((c) => c.url === 'https://www.reddit.com/api/v1/revoke_token' && c.form?.token === 'rd-refresh-SECRET')).toBe(true);
    expect(await prisma.socialAccount.count({ where: { platform: 'REDDIT' } })).toBe(0);
    expect(await social.getValidAccessToken('REDDIT')).toBeNull();
    await ceo.post('/api/social/reddit/disconnect').send({}).expect(404);
  });

  it('marks a connection EXPIRED when the provider rejects the token', async () => {
    await connect('linkedin');
    // Simulate LinkedIn revoking the token on their side.
    const social = app.get(SocialService);
    const enc = (social as unknown as { cipher: { encrypt: (s: string) => string } }).cipher.encrypt('revoked-token');
    await prisma.socialAccount.update({ where: { platform: 'LINKEDIN' }, data: { accessTokenEnc: enc } });
    const res = await ceo.post('/api/social/linkedin/verify').send({}).expect(200);
    expect(res.body.status).toBe('EXPIRED');
    expect(res.body.lastError).toContain('Reconnect');
  });

  it('Connect All walks every configured platform, one consent screen at a time', async () => {
    let r = await ceo.post('/api/control/connect-all').send({}).expect(200);
    expect(r.body.next.platform).toBe('LINKEDIN');
    expect(r.body.pending).toEqual(['LINKEDIN', 'FACEBOOK', 'REDDIT', 'X']);

    // Each callback returns with connectAll=1 so the UI continues the chain.
    for (const expected of ['linkedin', 'facebook', 'reddit', 'x']) {
      expect(r.body.next.platform.toLowerCase()).toBe(expected);
      const { code, state } = fake.issue(expected, r.body.next.authorizationUrl);
      const cb = await request(app.getHttpServer()).get(`/api/social/${expected}/callback`).query({ code, state }).expect(302);
      expect(cb.headers.location).toBe(`http://localhost:5173/control?social=${expected}&result=connected&connectAll=1`);
      r = await ceo.post('/api/control/connect-all').send({}).expect(200);
    }
    expect(r.body.next).toBeNull();
    expect(r.body.connected).toEqual(['LINKEDIN', 'FACEBOOK', 'REDDIT', 'X']);
    const status = await ceo.get('/api/control/status').expect(200);
    expect(status.body.totals.socialConnected).toBe(4);
    expect(JSON.stringify(status.body)).not.toMatch(/SECRET/);
  });

  it('Start All without an AI provider reports the AI worker as blocked instead of pretending', async () => {
    const res = await ceo.post('/api/control/start-all').send({}).expect(200);
    const worker = res.body.items.find((i: { target: string }) => i.target === 'ai-task-worker');
    expect(worker.ok).toBe(false);
    expect(worker.message).toContain('OPENAI_API_KEY');
    expect(res.body.ok).toBe(false);
    expect(await prisma.workflowControl.findUnique({ where: { key: 'ai-task-worker' } })).toBeNull();
  });
});

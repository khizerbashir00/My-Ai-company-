import { canonicalizeUrl } from '../../leads/url';
import { ConnectorHttpError, httpGetJson, httpPostForm } from '../http-client';
import type {
  ConnectorDescriptor,
  ConnectorLeadCandidate,
  ConnectorPage,
  ConnectorScanOptions,
  LeadSourceConnector,
} from '../connector.types';

/**
 * Reddit official API (OAuth application-only / refresh token).
 * Docs: https://www.reddit.com/dev/api
 *
 * Free path: create an app at https://www.reddit.com/prefs/apps (script or web app),
 * set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET. Optional REDDIT_REFRESH_TOKEN for
 * user-authorized access; otherwise client_credentials is used.
 * No scraping, no login-password harvest.
 */
export const REDDIT_SOURCE_KEY = 'reddit';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const OAUTH_BASE = 'https://oauth.reddit.com';

const DEFAULT_QUERY = 'looking for developer OR "need a website" OR "looking for a website" OR forhire';
const DEFAULT_SUBREDDITS = ['forhire', 'webdev', 'slavelabour', 'hireawriter'];

export interface RedditListingChild {
  kind?: string;
  data?: RedditPostData;
}

export interface RedditPostData {
  id?: string | null;
  name?: string | null;
  title?: string | null;
  selftext?: string | null;
  author?: string | null;
  permalink?: string | null;
  url?: string | null;
  created_utc?: number | null;
  subreddit?: string | null;
  is_self?: boolean | null;
}

interface RedditListingResponse {
  data?: {
    children?: RedditListingChild[];
    after?: string | null;
    dist?: number | null;
  };
}

interface RedditTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

type TokenCache = { token: string; expiresAt: number };

export class RedditConnector implements LeadSourceConnector {
  private tokenCache: TokenCache | null = null;

  readonly descriptor: ConnectorDescriptor = {
    key: REDDIT_SOURCE_KEY,
    name: 'Reddit',
    platform: 'reddit',
    accessMethod: 'OFFICIAL_API',
    description:
      'Searches public Reddit posts via the official OAuth API (free app credentials). Configure subreddits and a search query; never invents emails.',
    complianceNotes:
      'Uses https://www.reddit.com/dev/api with OAuth only. No scraping, no CAPTCHA bypass, no password login. Stay within Reddit rate limits. Contact authors only through channels they publish.',
    capabilities: ['search', 'pagination', 'public_posts'],
    credentialsEnv: 'REDDIT_CLIENT_ID',
    requiredConfigKeys: ['query', 'subreddits'],
    documentationUrl: 'https://www.reddit.com/dev/api',
    defaultScanIntervalMinutes: 360,
    defaultMaxResults: 40,
    maxPagesPerScan: 5,
  };

  isAuthorized(env: NodeJS.ProcessEnv): boolean {
    const id = env.REDDIT_CLIENT_ID?.trim();
    const secret = env.REDDIT_CLIENT_SECRET?.trim();
    return Boolean(id && secret);
  }

  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const query = typeof config.query === 'string' ? config.query.trim() : '';
    if (!query) errors.push('query is required (full-text search string).');
    if (query.length > 300) errors.push('query must be at most 300 characters.');
    const subs = parseSubreddits(config.subreddits);
    if (!subs.length) errors.push('subreddits is required (comma-separated list, e.g. forhire,webdev).');
    if (subs.length > 20) errors.push('subreddits must list at most 20 names.');
    for (const s of subs) {
      if (!/^[A-Za-z0-9_]{2,50}$/.test(s)) errors.push(`Invalid subreddit name "${s}".`);
    }
    if (config.limit != null) {
      const n = Number(config.limit);
      if (!Number.isInteger(n) || n < 1 || n > 100) errors.push('limit must be an integer from 1 to 100.');
    }
    if (config.maxPages != null) {
      const n = Number(config.maxPages);
      if (!Number.isInteger(n) || n < 1 || n > this.descriptor.maxPagesPerScan) {
        errors.push(`maxPages must be an integer from 1 to ${this.descriptor.maxPagesPerScan}.`);
      }
    }
    return errors;
  }

  async fetchPage(options: ConnectorScanOptions): Promise<ConnectorPage> {
    const errors = this.validateConfig(options.config);
    if (errors.length) throw new ConnectorHttpError(errors.join(' '), undefined, false);
    if (!this.isAuthorized(process.env)) {
      throw new ConnectorHttpError('Reddit credentials missing (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET)', undefined, false);
    }

    const query = String(options.config.query).trim();
    const subreddits = parseSubreddits(options.config.subreddits);
    const limit = clampInt(options.config.limit, 25, 1, 100);
    const maxPages = clampInt(options.config.maxPages, this.descriptor.maxPagesPerScan, 1, this.descriptor.maxPagesPerScan);
    const page = options.cursor ? Number(options.cursor.split('|')[0]) : 0;
    const after = options.cursor?.includes('|') ? options.cursor.split('|').slice(1).join('|') || null : null;
    if (!Number.isInteger(page) || page < 0) throw new ConnectorHttpError('Invalid pagination cursor', undefined, false);
    if (page >= maxPages) return { items: [], nextCursor: null };

    const token = await this.getAccessToken(options.signal);
    const sr = subreddits.join('+');
    const url = new URL(`${OAUTH_BASE}/r/${sr}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('restrict_sr', 'true');
    url.searchParams.set('sort', 'new');
    url.searchParams.set('t', 'month');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('raw_json', '1');
    url.searchParams.set('type', 'link');
    if (after) url.searchParams.set('after', after);

    const data = await httpGetJson<RedditListingResponse>({
      url: url.toString(),
      timeoutMs: 15_000,
      maxRetries: 3,
      baseBackoffMs: 1000,
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': redditUserAgent(),
      },
    });

    const children = data.data?.children ?? [];
    const items: ConnectorLeadCandidate[] = [];
    for (const child of children) {
      const mapped = mapPost(child.data);
      if (mapped) items.push(mapped);
      if (items.length >= options.maxResults) break;
    }

    const nextAfter = data.data?.after ?? null;
    const nextPage = page + 1;
    const more =
      Boolean(nextAfter) && nextPage < maxPages && items.length < options.maxResults && children.length > 0;

    return {
      items,
      nextCursor: more && nextAfter ? `${nextPage}|${nextAfter}` : null,
      estimatedTotal: data.data?.dist ?? undefined,
    };
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 30_000) {
      return this.tokenCache.token;
    }

    const clientId = process.env.REDDIT_CLIENT_ID!.trim();
    const clientSecret = process.env.REDDIT_CLIENT_SECRET!.trim();
    const refresh = process.env.REDDIT_REFRESH_TOKEN?.trim();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const body: Record<string, string> = refresh
      ? { grant_type: 'refresh_token', refresh_token: refresh }
      : { grant_type: 'client_credentials' };

    const data = await httpPostForm<RedditTokenResponse>({
      url: TOKEN_URL,
      body,
      timeoutMs: 12_000,
      maxRetries: 2,
      baseBackoffMs: 800,
      signal,
      headers: {
        Authorization: `Basic ${basic}`,
        'User-Agent': redditUserAgent(),
      },
    });

    if (!data.access_token) {
      const detail = data.error_description || data.error || 'no access_token';
      throw new ConnectorHttpError(`Reddit token request failed: ${detail}`, undefined, false);
    }

    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.tokenCache = { token: data.access_token, expiresAt: now + expiresIn * 1000 };
    return data.access_token;
  }
}

export function defaultRedditConfig(): Record<string, unknown> {
  return {
    query: DEFAULT_QUERY,
    subreddits: DEFAULT_SUBREDDITS.join(','),
    limit: 25,
    maxPages: 3,
    maxResults: 40,
  };
}

/** Exported for unit tests — maps a single listing post without network I/O. */
export function mapPost(post: RedditPostData | null | undefined): ConnectorLeadCandidate | null {
  if (!post) return null;
  const id = (post.id || post.name || '').trim();
  if (!id) return null;

  const title = (post.title || '').trim();
  const body = (post.selftext || '').trim();
  if (!title && !body) return null;

  const permalink = post.permalink?.trim();
  const sourceUrl = permalink
    ? permalink.startsWith('http')
      ? permalink
      : `https://www.reddit.com${permalink.startsWith('/') ? '' : '/'}${permalink}`
    : null;
  if (!sourceUrl || !canonicalizeUrl(sourceUrl)) return null;

  const externalId = post.name?.trim() || `t3_${id}`;
  const websiteUrl =
    post.is_self === false && post.url && canonicalizeUrl(post.url) && !post.url.includes('reddit.com')
      ? post.url
      : null;

  const requirements = [title, body].filter(Boolean).join('\n\n').slice(0, 5000);
  const postDate =
    post.created_utc && Number.isFinite(post.created_utc) ? new Date(post.created_utc * 1000) : null;

  return {
    externalId,
    name: (title || `Reddit ${externalId}`).slice(0, 200),
    contactName: post.author && post.author !== '[deleted]' ? String(post.author).slice(0, 200) : null,
    contactEmail: null,
    contactUrl:
      post.author && post.author !== '[deleted]'
        ? `https://www.reddit.com/user/${encodeURIComponent(post.author)}`
        : null,
    websiteUrl,
    requirements,
    requestedSkills: inferSkills(requirements),
    budgetText: null,
    notes: `Discovered via Reddit API${post.subreddit ? ` (r/${post.subreddit})` : ''}. Manual CSV import is available if this connector is disabled.`,
    sourceUrl,
    postDate: postDate && !Number.isNaN(postDate.getTime()) ? postDate : null,
    discoveredAt: new Date(),
    rawSnapshot: {
      id: post.id ?? null,
      name: post.name ?? null,
      subreddit: post.subreddit ?? null,
      api: 'oauth.reddit.com',
    },
  };
}

export function parseSubreddits(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim().replace(/^r\//i, '')).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,+\s]+/)
      .map((s) => s.trim().replace(/^r\//i, ''))
      .filter(Boolean);
  }
  return [];
}

function redditUserAgent(): string {
  const custom = process.env.REDDIT_USER_AGENT?.trim();
  if (custom) return custom;
  return 'ai-company-hq/0.1 (lead source connector; contact: local-dev)';
}

function inferSkills(text: string): string[] {
  const skills: string[] = [];
  const lower = text.toLowerCase();
  for (const skill of ['react', 'next.js', 'node', 'typescript', 'wordpress', 'shopify', 'e-commerce', 'full-stack', 'python', 'django']) {
    if (lower.includes(skill)) {
      skills.push(
        skill === 'next.js' ? 'Next.js' : skill === 'e-commerce' ? 'E-commerce' : skill[0]!.toUpperCase() + skill.slice(1),
      );
    }
  }
  return [...new Set(skills)].slice(0, 10);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

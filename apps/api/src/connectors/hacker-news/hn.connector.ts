import { canonicalizeUrl } from '../../leads/url';
import { ConnectorHttpError, httpGetJson } from '../http-client';
import type {
  ConnectorDescriptor,
  ConnectorLeadCandidate,
  ConnectorPage,
  ConnectorScanOptions,
  LeadSourceConnector,
} from '../connector.types';

/**
 * Hacker News Search API (Algolia-powered).
 * Docs: https://hn.algolia.com/api
 *
 * Access: public HTTP GET search — no API key.
 * Historical guidance cited ~1000 requests/IP/hour; we keep scans small and paced.
 * Commercial-use: only reads public story/Ask HN content; no login, no scraping of
 * login walls, no CAPTCHA bypass. Respect rate limits; do not bulk-exfiltrate the index.
 */
export const HN_SOURCE_KEY = 'hacker_news';

const HN_SEARCH_BASE = 'https://hn.algolia.com/api/v1/search_by_date';

export interface HnHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  author?: string | null;
  created_at?: string | null;
  created_at_i?: number | null;
  points?: number | null;
  num_comments?: number | null;
  story_text?: string | null;
  comment_text?: string | null;
  _tags?: string[];
}

interface HnSearchResponse {
  hits: HnHit[];
  page: number;
  nbPages: number;
  hitsPerPage: number;
  nbHits: number;
}

const DEFAULT_QUERY = 'website OR "web app" OR "web developer" OR "need a site" OR "looking for a developer"';
/** OR of Ask HN + stories (Algolia numeric filters / tag syntax). */
const DEFAULT_TAGS = '(ask_hn,story)';

export class HackerNewsConnector implements LeadSourceConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: HN_SOURCE_KEY,
    name: 'Hacker News',
    platform: 'hacker_news',
    accessMethod: 'OFFICIAL_API',
    description:
      'Searches public Hacker News stories and Ask HN posts via the official HN Search API (Algolia) for people requesting websites or web development.',
    complianceNotes:
      'Uses the public HN Search API (https://hn.algolia.com/api). No API key. Stay within rate limits (~1000 req/IP/hour historically). Only public posts. No login, no CAPTCHA bypass, no scraping of protected pages. Contact authors only through channels they publish and your own compliance rules allow.',
    capabilities: ['search', 'pagination', 'public_posts'],
    credentialsEnv: null,
    requiredConfigKeys: ['query'],
    documentationUrl: 'https://hn.algolia.com/api',
    defaultScanIntervalMinutes: 360,
    defaultMaxResults: 40,
    maxPagesPerScan: 5,
  };

  isAuthorized(_env: NodeJS.ProcessEnv): boolean {
    // Public search API — no credentials.
    return true;
  }

  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const query = typeof config.query === 'string' ? config.query.trim() : '';
    if (!query) errors.push('query is required (full-text search string).');
    if (query.length > 300) errors.push('query must be at most 300 characters.');
    if (config.tags != null && typeof config.tags !== 'string') errors.push('tags must be a string (e.g. (ask_hn,story)).');
    if (config.hitsPerPage != null) {
      const n = Number(config.hitsPerPage);
      if (!Number.isInteger(n) || n < 1 || n > 100) errors.push('hitsPerPage must be an integer from 1 to 100.');
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

    const query = String(options.config.query).trim();
    const tags = typeof options.config.tags === 'string' && options.config.tags.trim() ? options.config.tags.trim() : DEFAULT_TAGS;
    const hitsPerPage = clampInt(options.config.hitsPerPage, 20, 1, 100);
    const maxPages = clampInt(options.config.maxPages, this.descriptor.maxPagesPerScan, 1, this.descriptor.maxPagesPerScan);
    const page = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isInteger(page) || page < 0) throw new ConnectorHttpError('Invalid pagination cursor', undefined, false);
    if (page >= maxPages) return { items: [], nextCursor: null };

    const url = new URL(HN_SEARCH_BASE);
    url.searchParams.set('query', query);
    url.searchParams.set('tags', tags);
    url.searchParams.set('hitsPerPage', String(hitsPerPage));
    url.searchParams.set('page', String(page));

    const data = await httpGetJson<HnSearchResponse>({
      url: url.toString(),
      timeoutMs: 12_000,
      maxRetries: 3,
      baseBackoffMs: 800,
      signal: options.signal,
      headers: { 'User-Agent': 'ai-company-hq/0.1 (HN connector; +https://localhost)' },
    });

    const items: ConnectorLeadCandidate[] = [];
    for (const hit of data.hits ?? []) {
      const mapped = mapHit(hit);
      if (mapped) items.push(mapped);
      if (items.length >= options.maxResults) break;
    }

    const nextPage = page + 1;
    const more =
      nextPage < data.nbPages && nextPage < maxPages && items.length < options.maxResults && (data.hits?.length ?? 0) > 0;

    return {
      items,
      nextCursor: more ? String(nextPage) : null,
      estimatedTotal: data.nbHits,
    };
  }
}

export function defaultHnConfig(): Record<string, unknown> {
  return {
    query: DEFAULT_QUERY,
    tags: DEFAULT_TAGS,
    hitsPerPage: 20,
    maxPages: 3,
  };
}

/** Exported for unit tests — maps a single HN hit without network I/O. */
export function mapHit(hit: HnHit): ConnectorLeadCandidate | null {
  const objectId = hit.objectID?.trim();
  if (!objectId) return null;

  const title = (hit.title || hit.story_title || '').trim();
  const body = stripHtml(hit.story_text || hit.comment_text || '').trim();
  if (!title && !body) return null;

  // Prefer the public HN item URL as the durable source of truth.
  const sourceUrl = `https://news.ycombinator.com/item?id=${objectId}`;
  if (!canonicalizeUrl(sourceUrl)) return null;

  const externalUrl = hit.url || hit.story_url || null;
  const websiteUrl = externalUrl && canonicalizeUrl(externalUrl) ? externalUrl : null;

  const requirements = [title, body].filter(Boolean).join('\n\n').slice(0, 5000);
  const postDate =
    hit.created_at_i && Number.isFinite(hit.created_at_i)
      ? new Date(hit.created_at_i * 1000)
      : hit.created_at
        ? new Date(hit.created_at)
        : null;

  return {
    externalId: objectId,
    name: (title || `HN item ${objectId}`).slice(0, 200),
    contactName: hit.author ? String(hit.author).slice(0, 200) : null,
    contactEmail: null, // HN does not expose emails via this API
    contactUrl: hit.author ? `https://news.ycombinator.com/user?id=${encodeURIComponent(hit.author)}` : null,
    websiteUrl,
    requirements,
    requestedSkills: inferSkills(requirements),
    budgetText: null, // never invent
    notes: 'Discovered via Hacker News Search API (public). Manual import is available if this connector is disabled.',
    sourceUrl,
    postDate: postDate && !Number.isNaN(postDate.getTime()) ? postDate : null,
    discoveredAt: new Date(),
    rawSnapshot: {
      objectID: hit.objectID,
      points: hit.points ?? null,
      num_comments: hit.num_comments ?? null,
      tags: hit._tags ?? [],
      api: 'hn.algolia.com',
    },
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function inferSkills(text: string): string[] {
  const skills: string[] = [];
  const lower = text.toLowerCase();
  for (const skill of ['react', 'next.js', 'node', 'typescript', 'wordpress', 'shopify', 'e-commerce', 'full-stack']) {
    if (lower.includes(skill)) skills.push(skill === 'next.js' ? 'Next.js' : skill === 'e-commerce' ? 'E-commerce' : skill[0]!.toUpperCase() + skill.slice(1));
  }
  return [...new Set(skills)].slice(0, 10);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

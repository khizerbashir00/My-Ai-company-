import { HackerNewsConnector, mapHit, type HnHit } from './hn.connector';
import * as http from '../http-client';

describe('HackerNewsConnector', () => {
  const connector = new HackerNewsConnector();

  describe('mapHit', () => {
    it('normalizes a story into a lead candidate with source URL and external id', () => {
      const hit: HnHit = {
        objectID: '12345',
        title: 'Ask HN: Need a React website for my clinic',
        author: 'clinic_founder',
        url: 'https://clinic.example',
        created_at_i: 1_700_000_000,
        story_text: 'Looking for a developer. Budget $5k.',
        _tags: ['ask_hn'],
      };
      const mapped = mapHit(hit);
      expect(mapped).not.toBeNull();
      expect(mapped!.externalId).toBe('12345');
      expect(mapped!.sourceUrl).toBe('https://news.ycombinator.com/item?id=12345');
      expect(mapped!.contactName).toBe('clinic_founder');
      expect(mapped!.contactEmail).toBeNull();
      expect(mapped!.websiteUrl).toBe('https://clinic.example');
      expect(mapped!.requirements).toContain('Need a React website');
      expect(mapped!.requestedSkills).toContain('React');
      expect(mapped!.budgetText).toBeNull(); // never invent from free text in mapper
      expect(mapped!.postDate?.toISOString()).toBe(new Date(1_700_000_000 * 1000).toISOString());
    });

    it('returns null for empty hits', () => {
      expect(mapHit({ objectID: '' })).toBeNull();
      expect(mapHit({ objectID: '1', title: null, story_text: null })).toBeNull();
    });
  });

  describe('validateConfig', () => {
    it('requires query', () => {
      expect(connector.validateConfig({})).toEqual(expect.arrayContaining([expect.stringMatching(/query/i)]));
      expect(connector.validateConfig({ query: 'website' })).toEqual([]);
    });
  });

  describe('fetchPage', () => {
    afterEach(() => jest.restoreAllMocks());

    it('paginates with cursor and respects maxResults', async () => {
      const spy = jest.spyOn(http, 'httpGetJson').mockResolvedValue({
        hits: [
          {
            objectID: '1',
            title: 'Need a website',
            author: 'a',
            created_at_i: 1_700_000_000,
          },
          {
            objectID: '2',
            title: 'Need a web app',
            author: 'b',
            created_at_i: 1_700_000_100,
          },
        ],
        page: 0,
        nbPages: 5,
        hitsPerPage: 20,
        nbHits: 100,
      });

      const page = await connector.fetchPage({
        config: { query: 'website', hitsPerPage: 20, maxPages: 3 },
        cursor: null,
        maxResults: 1,
      });

      expect(spy).toHaveBeenCalled();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.externalId).toBe('1');
      // maxResults filled from this page — no further pages requested
      expect(page.nextCursor).toBeNull();
    });

    it('returns next cursor when more pages exist and maxResults is not filled', async () => {
      jest.spyOn(http, 'httpGetJson').mockResolvedValue({
        hits: [{ objectID: '1', title: 'Need a website', author: 'a', created_at_i: 1_700_000_000 }],
        page: 0,
        nbPages: 5,
        hitsPerPage: 20,
        nbHits: 100,
      });

      const page = await connector.fetchPage({
        config: { query: 'website', hitsPerPage: 20, maxPages: 3 },
        cursor: null,
        maxResults: 50,
      });
      expect(page.nextCursor).toBe('1');
    });

    it('stops when page >= maxPages', async () => {
      const spy = jest.spyOn(http, 'httpGetJson');
      const page = await connector.fetchPage({
        config: { query: 'website', maxPages: 2 },
        cursor: '2',
        maxResults: 10,
      });
      expect(page).toEqual({ items: [], nextCursor: null });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('is authorized without credentials', () => {
    expect(connector.isAuthorized({})).toBe(true);
  });
});

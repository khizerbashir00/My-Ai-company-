import { mapPost, parseSubreddits, RedditConnector, type RedditPostData } from './reddit.connector';
import * as http from '../http-client';

describe('RedditConnector', () => {
  const connector = new RedditConnector();

  describe('mapPost', () => {
    it('normalizes a listing into a lead candidate without inventing email', () => {
      const post: RedditPostData = {
        id: 'abc123',
        name: 't3_abc123',
        title: 'Looking for a React developer for my clinic site',
        selftext: 'Need a website. Budget flexible. Contact via DM.',
        author: 'clinic_founder',
        permalink: '/r/forhire/comments/abc123/looking_for_a_react_developer/',
        created_utc: 1_700_000_000,
        subreddit: 'forhire',
        is_self: true,
      };
      const mapped = mapPost(post);
      expect(mapped).not.toBeNull();
      expect(mapped!.externalId).toBe('t3_abc123');
      expect(mapped!.sourceUrl).toContain('reddit.com/r/forhire/comments/abc123');
      expect(mapped!.contactName).toBe('clinic_founder');
      expect(mapped!.contactEmail).toBeNull();
      expect(mapped!.requirements).toContain('React developer');
      expect(mapped!.requestedSkills).toContain('React');
      expect(mapped!.budgetText).toBeNull();
    });

    it('returns null for empty posts', () => {
      expect(mapPost(null)).toBeNull();
      expect(mapPost({ id: '1', title: null, selftext: null })).toBeNull();
    });
  });

  describe('parseSubreddits', () => {
    it('accepts comma-separated and r/ prefixes', () => {
      expect(parseSubreddits('forhire, r/webdev')).toEqual(['forhire', 'webdev']);
      expect(parseSubreddits(['forhire', 'webdev'])).toEqual(['forhire', 'webdev']);
    });
  });

  describe('validateConfig', () => {
    it('requires query and subreddits', () => {
      expect(connector.validateConfig({})).toEqual(expect.arrayContaining([expect.stringMatching(/query/i)]));
      expect(connector.validateConfig({ query: 'website' })).toEqual(
        expect.arrayContaining([expect.stringMatching(/subreddits/i)]),
      );
      expect(connector.validateConfig({ query: 'website', subreddits: 'forhire,webdev' })).toEqual([]);
    });
  });

  describe('isAuthorized', () => {
    it('requires client id and secret', () => {
      expect(connector.isAuthorized({})).toBe(false);
      expect(connector.isAuthorized({ REDDIT_CLIENT_ID: 'id' })).toBe(false);
      expect(connector.isAuthorized({ REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret' })).toBe(true);
    });
  });

  describe('fetchPage', () => {
    afterEach(() => jest.restoreAllMocks());

    it('paginates with cursor and maps posts', async () => {
      jest.spyOn(http, 'httpPostForm').mockResolvedValue({
        access_token: 'tok',
        expires_in: 3600,
      });
      jest.spyOn(http, 'httpGetJson').mockResolvedValue({
        data: {
          children: [
            {
              kind: 't3',
              data: {
                id: 'p1',
                name: 't3_p1',
                title: 'Need a website',
                selftext: 'Looking for developer',
                author: 'u1',
                permalink: '/r/forhire/comments/p1/need_a_website/',
                created_utc: 1_700_000_000,
                subreddit: 'forhire',
                is_self: true,
              },
            },
          ],
          after: 't3_next',
        },
      });

      const prev = { REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET };
      process.env.REDDIT_CLIENT_ID = 'id';
      process.env.REDDIT_CLIENT_SECRET = 'secret';
      try {
        const page = await connector.fetchPage({
          config: { query: 'website', subreddits: 'forhire', maxPages: 2 },
          maxResults: 10,
        });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.externalId).toBe('t3_p1');
        expect(page.nextCursor).toBe('1|t3_next');
      } finally {
        if (prev.REDDIT_CLIENT_ID === undefined) delete process.env.REDDIT_CLIENT_ID;
        else process.env.REDDIT_CLIENT_ID = prev.REDDIT_CLIENT_ID;
        if (prev.REDDIT_CLIENT_SECRET === undefined) delete process.env.REDDIT_CLIENT_SECRET;
        else process.env.REDDIT_CLIENT_SECRET = prev.REDDIT_CLIENT_SECRET;
      }
    });
  });
});

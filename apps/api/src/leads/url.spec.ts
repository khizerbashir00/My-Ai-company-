import { canonicalizeUrl } from './url';

describe('canonicalizeUrl', () => {
  it('normalizes host, strips www and tracking params', () => {
    expect(canonicalizeUrl('HTTPS://www.Example.com/jobs/1/?utm_source=x&fbclid=1')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('rejects non-http schemes', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
  });
});

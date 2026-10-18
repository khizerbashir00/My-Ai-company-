import { TokenCipher } from './token-cipher';

const key = Buffer.alloc(32, 3).toString('base64');

describe('TokenCipher', () => {
  it('round-trips and never produces the plaintext or a repeated ciphertext', () => {
    const c = TokenCipher.fromConfig({ tokenKeyB64: key, jwtSecret: 'x'.repeat(40), isProduction: true });
    const a = c.encrypt('access-token-123');
    const b = c.encrypt('access-token-123');
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain('access-token-123');
    expect(a).not.toBe(b); // random IV
    expect(c.decrypt(a)).toBe('access-token-123');
  });

  it('rejects tampered ciphertext and the wrong key (GCM authentication)', () => {
    const c = TokenCipher.fromConfig({ tokenKeyB64: key, jwtSecret: 'x'.repeat(40), isProduction: true });
    const enc = c.encrypt('secret');
    const parts = enc.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => c.decrypt([parts[0], parts[1], parts[2], flipped.toString('base64url')].join('.'))).toThrow();
    const other = TokenCipher.fromConfig({ tokenKeyB64: Buffer.alloc(32, 9).toString('base64'), jwtSecret: 'x'.repeat(40), isProduction: true });
    expect(() => other.decrypt(enc)).toThrow();
    expect(() => c.decrypt('garbage')).toThrow('Unrecognized token format');
  });

  it('is unavailable in production without TOKEN_ENCRYPTION_KEY, and derives a dev key otherwise', () => {
    const prod = TokenCipher.fromConfig({ tokenKeyB64: null, jwtSecret: 'x'.repeat(40), isProduction: true });
    expect(prod.available).toBe(false);
    expect(() => prod.encrypt('a')).toThrow('TOKEN_ENCRYPTION_KEY');
    const dev1 = TokenCipher.fromConfig({ tokenKeyB64: null, jwtSecret: 'y'.repeat(40), isProduction: false });
    const dev2 = TokenCipher.fromConfig({ tokenKeyB64: null, jwtSecret: 'y'.repeat(40), isProduction: false });
    expect(dev1.source).toBe('derived-dev');
    expect(dev2.decrypt(dev1.encrypt('stable'))).toBe('stable');
  });
});

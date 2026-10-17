import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for OAuth tokens at rest.
 *
 * Format: `v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>`. The version prefix leaves room
 * for key rotation. GCM authenticates the ciphertext, so tampered or wrong-key values fail to decrypt
 * instead of yielding garbage.
 */
export class TokenCipher {
  private constructor(
    private readonly key: Buffer | null,
    readonly source: 'env' | 'derived-dev' | 'none',
  ) {}

  /**
   * - TOKEN_ENCRYPTION_KEY set → use it (required for production).
   * - Not production and unset → derive a stable key from JWT_SECRET (HKDF) so local dev works out of the box.
   * - Production and unset → unavailable; social connect is disabled with a clear reason.
   */
  static fromConfig(opts: { tokenKeyB64: string | null; jwtSecret: string; isProduction: boolean }): TokenCipher {
    if (opts.tokenKeyB64) {
      const key = Buffer.from(opts.tokenKeyB64, 'base64');
      if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
      return new TokenCipher(key, 'env');
    }
    if (!opts.isProduction) {
      const key = Buffer.from(hkdfSync('sha256', opts.jwtSecret, 'hq-token-cipher', 'oauth-tokens-v1', 32));
      return new TokenCipher(key, 'derived-dev');
    }
    return new TokenCipher(null, 'none');
  }

  get available(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const key = this.requireKey();
    const [version, ivB64, tagB64, ctB64] = payload.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Unrecognized token format');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('Token encryption key is not configured (TOKEN_ENCRYPTION_KEY).');
    return this.key;
  }
}

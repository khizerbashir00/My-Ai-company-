export interface SendEmailInput {
  to: string;
  subject: string;
  bodyText: string;
  /** Optional threading headers */
  inReplyTo?: string | null;
  references?: string | null;
  /** Idempotency / correlation for providers that support it */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  provider: string;
  messageId: string;
  deliveryStatus: string;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly providerStatus?: string,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

export class EmailNotConfiguredError extends Error {
  constructor(message = 'Email provider is not configured. Set EMAIL_PROVIDER, RESEND_API_KEY, and EMAIL_FROM.') {
    super(message);
    this.name = 'EmailNotConfiguredError';
  }
}

/** Common interface for supported outbound email providers. */
export interface EmailProvider {
  readonly key: string;
  isConfigured(): boolean;
  /** CEO-authorized from address, or null when unconfigured. */
  fromAddress(): string | null;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

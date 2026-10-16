import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  EmailNotConfiguredError,
  EmailProviderError,
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
} from './email.types';

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Resend HTTP API provider.
 * Auth: API key (RESEND_API_KEY). The FROM address must be on a verified domain in Resend.
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 *
 * This adapter does not claim delivery until credentials are configured and a send succeeds.
 */
@Injectable()
export class ResendEmailProvider implements EmailProvider {
  readonly key = 'resend';
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    return this.config.emailProviderKey === 'resend' && Boolean(this.config.resendApiKey && this.config.emailFrom);
  }

  fromAddress(): string | null {
    return this.isConfigured() ? this.config.emailFrom : null;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.isConfigured()) throw new EmailNotConfiguredError();
    const apiKey = this.config.resendApiKey!;
    const from = this.config.emailFrom!;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey.slice(0, 256);

    const payload: Record<string, unknown> = {
      from,
      to: [input.to],
      subject: input.subject,
      text: input.bodyText,
    };
    if (this.config.emailReplyTo) payload.reply_to = this.config.emailReplyTo;
    if (input.inReplyTo || input.references) {
      payload.headers = {
        ...(input.inReplyTo ? { 'In-Reply-To': input.inReplyTo } : {}),
        ...(input.references ? { References: input.references } : {}),
      };
    }

    let res: Response;
    try {
      res = await fetch(RESEND_API, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      throw new EmailProviderError(err instanceof Error ? err.message : 'Network error calling Resend', true);
    }

    const text = await res.text();
    let json: { id?: string; message?: string; name?: string } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      /* ignore */
    }

    if (!res.ok) {
      const msg = (json.message || json.name || `Resend HTTP ${res.status}`).slice(0, 500);
      this.logger.warn(`Resend send failed: ${res.status}`);
      throw new EmailProviderError(msg, res.status === 429 || res.status >= 500, String(res.status));
    }

    if (!json.id) throw new EmailProviderError('Resend response missing message id', false);
    return { provider: this.key, messageId: json.id, deliveryStatus: 'sent' };
  }
}

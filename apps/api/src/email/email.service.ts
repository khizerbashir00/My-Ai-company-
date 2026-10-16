import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { EmailNotConfiguredError, type EmailProvider, type SendEmailInput, type SendEmailResult } from './email.types';
import { ResendEmailProvider } from './resend.provider';

@Injectable()
export class EmailService {
  constructor(
    private readonly config: AppConfigService,
    private readonly resend: ResendEmailProvider,
  ) {}

  status() {
    return this.config.emailStatus;
  }

  /** Active provider when configured; otherwise null (do not claim live delivery). */
  activeProvider(): EmailProvider | null {
    if (this.config.emailProviderKey === 'resend' && this.resend.isConfigured()) return this.resend;
    return null;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const provider = this.activeProvider();
    if (!provider) throw new EmailNotConfiguredError();
    return provider.send(input);
  }
}

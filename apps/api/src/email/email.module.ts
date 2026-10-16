import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ResendEmailProvider } from './resend.provider';

@Global()
@Module({
  providers: [ResendEmailProvider, EmailService],
  exports: [EmailService, ResendEmailProvider],
})
export class EmailModule {}

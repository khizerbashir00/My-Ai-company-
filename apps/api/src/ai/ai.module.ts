import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AI_PROVIDER } from './ai.types';
import { OpenAiProvider } from './openai.provider';

@Global()
@Module({
  providers: [
    OpenAiProvider,
    { provide: AI_PROVIDER, useExisting: OpenAiProvider },
    AiService,
  ],
  exports: [AiService, AI_PROVIDER],
})
export class AiModule {}

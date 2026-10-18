import { Module, OnModuleInit } from '@nestjs/common';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { RedditConnector } from '../connectors/reddit/reddit.connector';
import { SocialController } from './social.controller';
import { fetchSocialHttp, SOCIAL_HTTP } from './social-http';
import { SocialService } from './social.service';

@Module({
  controllers: [SocialController],
  providers: [SocialService, { provide: SOCIAL_HTTP, useValue: fetchSocialHttp }],
  exports: [SocialService],
})
export class SocialModule implements OnModuleInit {
  constructor(
    private readonly social: SocialService,
    private readonly connectors: ConnectorRegistry,
  ) {}

  onModuleInit(): void {
    // Let the Reddit lead source scan with the CEO's connected Reddit account when there is one.
    const reddit = this.connectors.get(this.connectors.redditKey);
    if (reddit instanceof RedditConnector) {
      reddit.setUserTokenSource(() => this.social.getValidAccessToken('REDDIT'));
    }
  }
}

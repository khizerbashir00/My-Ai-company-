import { Global, Module } from '@nestjs/common';
import { ConnectorRegistry } from './connector.registry';

@Global()
@Module({
  providers: [ConnectorRegistry],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}

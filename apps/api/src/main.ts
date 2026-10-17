import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { JsonLogger } from './common/json-logger';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app);
  const config = app.get(AppConfigService);
  if (config.logFormat === 'json') {
    app.useLogger(new JsonLogger());
  }

  await app.listen(config.port);
  Logger.log(`API listening on http://localhost:${config.port}/api (${config.nodeEnv})`, 'Bootstrap');
  Logger.log(`Graceful shutdown enabled (compose stop_grace_period / orchestration SIGTERM).`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  // Config validation errors are already human-readable; never print env values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { SafeExceptionFilter } from './common/http-exception.filter';
import { AppConfigService } from './config/app-config.service';

/** Shared by main.ts and the e2e tests so tests run against the exact production configuration. */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfigService);
  const express = app as NestExpressApplication;

  // Behind Nginx/Caddy set TRUST_PROXY=1 so rate limits and audit logs see the real client IP.
  // Left at 0 when exposed directly, otherwise clients could spoof X-Forwarded-For to dodge rate limits.
  if (config.trustProxy > 0) express.set('trust proxy', config.trustProxy);
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: '1mb' });

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields
      forbidNonWhitelisted: true, // …and reject requests that send them
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new SafeExceptionFilter());
  app.enableShutdownHooks();
}

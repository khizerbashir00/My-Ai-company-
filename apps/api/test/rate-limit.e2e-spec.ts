import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CEO, createTestApp, resetDatabase } from './helpers';

describe('Login rate limiting (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
  });
  afterAll(async () => app.close());

  it('allows 5 attempts per minute and then returns 429', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 5; i++) {
      await request(server).post('/api/auth/login').send({ email: CEO.email, password: `wrong-password-${i}` }).expect(401);
    }
    const res = await request(server).post('/api/auth/login').send({ email: CEO.email, password: CEO.password }).expect(429);
    expect(res.body.message).toMatch(/Too many requests/);
  });
});

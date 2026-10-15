import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth.decorators';
import { BCRYPT_ROUNDS } from '../database/seed';
import type { JwtPayload } from './auth.constants';

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', BCRYPT_ROUNDS);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, ctx: RequestContext): Promise<{ token: string; user: AuthUser }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !ok || !user.isActive) {
      await this.audit.record({
        actorType: 'USER',
        actorUserId: user?.id ?? null,
        action: 'auth.login_failed',
        // Store a hint of the attempted account, not the full address, for unknown users
        data: { email: user ? user.email : maskEmail(email) },
        ctx,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ actorType: 'USER', actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ctx });

    const payload: JwtPayload = { sub: user.id, role: user.role };
    return {
      token: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  async changePassword(user: AuthUser, currentPassword: string, newPassword: string, ctx: RequestContext): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(currentPassword, row.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) } });
    await this.audit.record({ actorType: 'USER', actorUserId: user.id, action: 'auth.password_changed', entityType: 'user', entityId: user.id, ctx });
  }
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

/** "8h" → milliseconds, for the cookie lifetime. */
export function durationToMs(value: string): number {
  const m = /^(\d+)([smhd])$/.exec(value);
  if (!m) throw new Error(`Invalid duration: ${value}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

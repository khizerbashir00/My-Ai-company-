import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { UserRole } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, IS_PUBLIC_KEY, ROLES_KEY } from '../common/auth.decorators';
import { AUTH_COOKIE, JwtPayload } from './auth.constants';

/**
 * Global guard: authenticates every request (httpOnly cookie or Bearer token), reloads the user
 * so deactivated accounts and role changes take effect immediately, then enforces @Roles().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('Authentication required');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Session expired or invalid');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Session expired or invalid');
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException('You do not have permission to do this');
    return true;
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  const cookie = (req.cookies as Record<string, string> | undefined)?.[AUTH_COOKIE];
  return cookie || null;
}

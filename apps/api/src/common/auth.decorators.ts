import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '../generated/prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export const IS_PUBLIC_KEY = 'isPublic';
/** Opt a route out of authentication (login, health). Everything else is authenticated by default. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restrict a route to specific roles. Without it any authenticated user may call the route. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});

export const ReqContext = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null };
});

/** Roles allowed to change things. VIEWER is read-only. */
export const WRITE_ROLES: UserRole[] = ['CEO', 'ADMIN'];

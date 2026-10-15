export const AUTH_COOKIE = 'aic_session';

export interface JwtPayload {
  sub: string;
  role: string;
}

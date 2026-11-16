import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Role } from '@assessiq/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** Skips authentication for a route (login, register, health, ...). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route to the listed roles. Routes without @Roles allow any signed-in user. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);

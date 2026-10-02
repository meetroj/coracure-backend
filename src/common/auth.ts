import { ExecutionContext, HttpStatus, SetMetadata, createParamDecorator } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

import { AppException, PlatformError } from './errors';

/** The table an account lives in is its role. `system` is the platform itself. */
export type ActorType = 'patient' | 'doctor' | 'admin' | 'system';

/** Panel sections and data an admin may reach (MODULES 3, `admin_permission_level`). */
export type AdminPermissionLevel =
  'super_admin' | 'operations' | 'clinical_governance' | 'care_coordinator' | 'finance' | 'content';

/** Placed on the request by the authentication guard in M-02. */
export interface AuthenticatedActor {
  type: Exclude<ActorType, 'system'>;
  id: string;
  /** Admins only. */
  level?: AdminPermissionLevel;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}

export const ROLES_KEY = 'platform:roles';

/** Restricts a route to the given account kinds. Enforced by `RolesGuard`. */
export const Roles = (...roles: AuthenticatedActor['type'][]) => SetMetadata(ROLES_KEY, roles);

/** Injects the authenticated actor; throws rather than handing a handler `undefined`. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedActor => {
    const actor = context.switchToHttp().getRequest<FastifyRequest>().actor;
    if (!actor) {
      throw new AppException(
        PlatformError.UNAUTHENTICATED,
        'Authentication required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return actor;
  },
);

/**
 * Permission-level check for admin-only work. The role guard says the caller is
 * an admin; this says which admins. `super_admin` passes everything, because a
 * level that cannot reach a section is a level that cannot fix it.
 */
export function assertPermission(
  actor: AuthenticatedActor,
  ...allowed: AdminPermissionLevel[]
): void {
  const level = actor.type === 'admin' ? actor.level : undefined;
  if (level === 'super_admin' || (level && allowed.includes(level))) return;
  throw new AppException(
    PlatformError.INSUFFICIENT_PERMISSION,
    'Your admin role does not have access to this action',
    HttpStatus.FORBIDDEN,
  );
}

/**
 * Ownership check every module shares: a user reaches only their own records
 * (SRS 6.1, 6.2). `ownerId` must be the id of the same account kind as `actor`.
 * Admin access is never implicit - a caller that allows it says so.
 */
export function assertOwnership(
  actor: AuthenticatedActor,
  ownerId: string | null | undefined,
  options: { adminMayAccess?: boolean } = {},
): void {
  if (actor.type === 'admin' && options.adminMayAccess) return;
  if (!ownerId || actor.id !== ownerId) {
    throw new AppException(
      PlatformError.FORBIDDEN,
      'You do not have access to this record',
      HttpStatus.FORBIDDEN,
    );
  }
}

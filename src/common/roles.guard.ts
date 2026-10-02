import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';

import { AuthenticatedActor, ROLES_KEY } from './auth';
import { AppException, PlatformError } from './errors';

/**
 * Global role check. A route without `@Roles()` is not opened up here - M-02's
 * authentication guard decides those; this guard only enforces the declared kinds.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<AuthenticatedActor['type'][] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!roles?.length) return true;

    const actor = context.switchToHttp().getRequest<FastifyRequest>().actor;
    if (!actor) {
      throw new AppException(
        PlatformError.UNAUTHENTICATED,
        'Authentication required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!roles.includes(actor.type)) {
      throw new AppException(
        PlatformError.FORBIDDEN,
        'This account type cannot use this endpoint',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}

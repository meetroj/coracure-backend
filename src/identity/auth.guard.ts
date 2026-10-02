import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';

import { AppException } from '../common/errors';
import { AccountsService } from './accounts.service';
import { IdentityError } from './identity.errors';
import { PUBLIC_KEY } from './public.decorator';
import { TokensService } from './tokens.service';

/**
 * Turns a bearer token into `request.actor`, which every other guard and
 * `@CurrentActor()` read. Runs before `RolesGuard`, which then decides whether
 * that kind of account may use the route (MODULES M-02: each app accepts only
 * its own kind of account).
 *
 * There is no session lookup here. The token carries a `ver` claim and
 * `AccountsService.resolve` compares it with the account row's
 * `token_version`; a mismatch is a revoked token. That single comparison is
 * what replaces a session table.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly accounts: AccountsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = bearer(request.headers.authorization);
    if (!token) {
      throw new AppException(
        IdentityError.TOKEN_INVALID,
        'Authentication required',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Throws TOKEN_INVALID on an expired, tampered or wrong-audience token.
    const claims = await this.tokens.verifyAccess(token);

    const actor = await this.accounts.resolve(claims);
    if (!actor) {
      // Signed out everywhere, suspended, deleted, or a doctor token before M-05.
      throw new AppException(
        IdentityError.TOKEN_INVALID,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.actor = actor;
    return true;
  }
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

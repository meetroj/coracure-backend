import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';

import { AdminPermissionLevel, AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { env } from '../config/env.validation';
import { IdentityError } from './identity.errors';

/** Access and refresh are the same secret with different audiences, so one can never pass as the other. */
const AUDIENCE = {
  access: 'coracure/access',
  refresh: 'coracure/refresh',
  mfa: 'coracure/mfa',
} as const;

type TokenKind = keyof typeof AUDIENCE;

/**
 * `expiresIn` is typed as a template literal (`ms`), which a validated
 * environment string cannot satisfy structurally. The format is enforced at
 * boot by `env.validation`, so the cast is asserting what is already checked.
 */
const ttl = (value: string) => value as JwtSignOptions['expiresIn'];

interface Claims {
  sub: string;
  typ: AuthenticatedActor['type'];
  /**
   * *** REVOCATION *** the account row's `token_version` at issue. A token whose
   * `ver` no longer matches the row is refused, which is the whole of FR-1.8:
   * no session table, no stored token, one `UPDATE ... token_version + 1`.
   */
  ver: number;
  kind: TokenKind;
  /** Admins only. */
  lvl?: AdminPermissionLevel;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds, so a client can schedule its refresh without parsing the JWT. */
  expiresIn: number;
}

export interface TokenSubject {
  id: string;
  type: AuthenticatedActor['type'];
  tokenVersion: number;
  level?: AdminPermissionLevel;
}

@Injectable()
export class TokensService {
  constructor(private readonly jwt: JwtService) {}

  /** Issues the pair returned on a completed sign-in. Neither is stored anywhere. */
  async issue(subject: TokenSubject): Promise<TokenPair> {
    const claims = (kind: TokenKind): Claims => ({
      sub: subject.id,
      typ: subject.type,
      ver: subject.tokenVersion,
      kind,
      ...(subject.level ? { lvl: subject.level } : {}),
    });
    const config = env();

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(claims('access'), {
        audience: AUDIENCE.access,
        expiresIn: ttl(config.JWT_ACCESS_TTL),
      }),
      this.jwt.signAsync(claims('refresh'), {
        audience: AUDIENCE.refresh,
        expiresIn: ttl(config.JWT_REFRESH_TTL),
      }),
    ]);

    return { accessToken, refreshToken, expiresIn: seconds(config.JWT_ACCESS_TTL) };
  }

  /**
   * The short-lived handle an admin gets after a correct password but before
   * the two-factor code. It authenticates nothing: it only says which account
   * is halfway through signing in.
   */
  issueMfaChallenge(subject: TokenSubject, challengeId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: subject.id, typ: subject.type, ver: subject.tokenVersion, kind: 'mfa', challengeId },
      { audience: AUDIENCE.mfa, expiresIn: ttl(env().JWT_MFA_TTL) },
    );
  }

  verifyAccess(token: string): Promise<Claims> {
    return this.verify(token, 'access');
  }

  verifyRefresh(token: string): Promise<Claims> {
    return this.verify(token, 'refresh');
  }

  async verifyMfaChallenge(token: string): Promise<Claims & { challengeId: string }> {
    const claims = await this.verify(token, 'mfa');
    const challengeId = (claims as { challengeId?: unknown }).challengeId;
    if (typeof challengeId !== 'string') {
      throw this.rejected('Your sign-in attempt has expired. Please sign in again.');
    }
    return { ...claims, challengeId };
  }

  private async verify(token: string, kind: TokenKind): Promise<Claims> {
    let claims: Claims;
    try {
      claims = await this.jwt.verifyAsync<Claims>(token, { audience: AUDIENCE[kind] });
    } catch {
      // Expired, tampered with, or signed for a different audience - all one answer.
      throw this.rejected();
    }
    // Belt and braces: the audience check above already separates the kinds.
    if (claims.kind !== kind) throw this.rejected();
    return claims;
  }

  private rejected(message = 'Your session has expired. Please sign in again.'): AppException {
    return new AppException(IdentityError.TOKEN_INVALID, message, HttpStatus.UNAUTHORIZED);
  }
}

/** `15m`, `30d`, `900` -> seconds. Mirrors what jsonwebtoken accepts for expiresIn. */
function seconds(ttl: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(ttl.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  return value * { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] ?? 's']!;
}

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AuthenticatedActor, assertOwnership, assertPermission } from './auth';
import { AppException } from './errors';
import { RolesGuard } from './roles.guard';

const patient: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const admin: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };

function context(actor?: AuthenticatedActor): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ actor }) }),
  } as unknown as ExecutionContext;
}

function guardFor(roles: AuthenticatedActor['type'][] | undefined): RolesGuard {
  return new RolesGuard({ getAllAndOverride: () => roles } as unknown as Reflector);
}

describe('assertOwnership', () => {
  it('lets an owner through', () => {
    expect(() => assertOwnership(patient, 'patient-1')).not.toThrow();
  });

  it('stops a user reading another user record', () => {
    expect(() => assertOwnership(patient, 'patient-2')).toThrowError(AppException);
  });

  it('treats an unknown owner as no access', () => {
    expect(() => assertOwnership(patient, null)).toThrowError(AppException);
  });

  it('never lets an admin through implicitly', () => {
    expect(() => assertOwnership(admin, 'patient-1')).toThrowError(AppException);
    expect(() => assertOwnership(admin, 'patient-1', { adminMayAccess: true })).not.toThrow();
  });
});

describe('RolesGuard', () => {
  it('leaves an undecorated route to the authentication guard', () => {
    expect(guardFor(undefined).canActivate(context())).toBe(true);
  });

  it('admits an allowed account kind', () => {
    expect(guardFor(['patient']).canActivate(context(patient))).toBe(true);
  });

  it('refuses the wrong app signing in to the wrong endpoint', () => {
    expect(() => guardFor(['doctor']).canActivate(context(patient))).toThrowError(
      /This account type cannot use this endpoint/,
    );
  });

  it('refuses an unauthenticated request on a role-scoped route', () => {
    expect(() => guardFor(['admin']).canActivate(context())).toThrowError(
      /Authentication required/,
    );
  });
});

describe('assertPermission', () => {
  const at = (level: NonNullable<AuthenticatedActor['level']>): AuthenticatedActor => ({
    type: 'admin',
    id: 'admin-1',
    level,
  });

  it('admits an admin whose level is listed', () => {
    expect(() => assertPermission(at('operations'), 'operations')).not.toThrow();
  });

  it('refuses an admin whose level is not', () => {
    expect(() => assertPermission(at('finance'), 'operations', 'content')).toThrowError(
      /does not have access/,
    );
  });

  it('admits a super_admin to everything, including a list it is not on', () => {
    expect(() => assertPermission(at('super_admin'), 'finance')).not.toThrow();
    // A level that cannot reach a section is a level that cannot fix it.
    expect(() => assertPermission(at('super_admin'))).not.toThrow();
  });

  it('refuses every admin when no level is allowed but super_admin', () => {
    expect(() => assertPermission(at('operations'))).toThrowError(/does not have access/);
  });

  it('refuses a patient or doctor, which carry no level at all', () => {
    expect(() => assertPermission(patient, 'operations')).toThrowError(/does not have access/);
  });

  it('answers with INSUFFICIENT_PERMISSION rather than the role guard FORBIDDEN', () => {
    try {
      assertPermission(at('content'), 'finance');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('INSUFFICIENT_PERMISSION');
      expect((error as AppException).getStatus()).toBe(403);
    }
  });
});

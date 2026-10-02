import { Controller, ExecutionContext, Get, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { RolesGuard } from '../common/roles.guard';
import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { AccountsService } from './accounts.service';
import { AuthGuard } from './auth.guard';
import { Public } from './public.decorator';
import { TokensService } from './tokens.service';

const SECRET = 'x'.repeat(32);

const ENVIRONMENT = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: SECRET,
};

interface FakeRequest {
  headers: Record<string, string>;
  actor?: AuthenticatedActor;
}

function contextFor(authorization?: string): { context: ExecutionContext; request: FakeRequest } {
  const request: FakeRequest = { headers: authorization ? { authorization } : {} };
  const context = {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function guardWith(resolved: AuthenticatedActor | null, isPublic = false) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(isPublic) } as unknown as Reflector;
  const tokens = new TokensService(new JwtService({ secret: SECRET }));
  const accounts = { resolve: vi.fn().mockResolvedValue(resolved) } as unknown as AccountsService;
  return { guard: new AuthGuard(reflector, tokens, accounts), tokens };
}

describe('AuthGuard', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({ ...ENVIRONMENT });
  });

  it('lets a @Public route through without a token', async () => {
    const { guard } = guardWith(null, true);
    await expect(guard.canActivate(contextFor().context)).resolves.toBe(true);
  });

  it('is deny by default: no token, no entry', async () => {
    const { guard } = guardWith({ type: 'patient', id: 'patient-1' });
    await expect(guard.canActivate(contextFor().context)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });

  it('ignores a non-bearer authorization header', async () => {
    const { guard } = guardWith({ type: 'patient', id: 'patient-1' });
    await expect(guard.canActivate(contextFor('Basic abc123').context)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });

  it('puts the resolved actor on the request', async () => {
    const actor: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'finance' };
    const { guard, tokens } = guardWith(actor);
    const pair = await tokens.issue({
      id: 'admin-1',
      type: 'admin',
      tokenVersion: 0,
      level: 'finance',
    });

    const { context, request } = contextFor(`Bearer ${pair.accessToken}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.actor).toEqual(actor);
  });

  it('*** REVOCATION *** refuses a well-formed token the account no longer honours', async () => {
    const { guard, tokens } = guardWith(null);
    const pair = await tokens.issue({ id: 'patient-1', type: 'patient', tokenVersion: 0 });
    await expect(
      guard.canActivate(contextFor(`Bearer ${pair.accessToken}`).context),
    ).rejects.toMatchObject({ response: { code: 'TOKEN_INVALID' } });
  });
});

// ---------------------------------------------------------------------------
// Guard ORDER is a real constraint, not a comment: AuthGuard must populate
// `request.actor` before RolesGuard reads it, or every @Roles route would
// answer 401 to a valid token. This boots the two the way app.module.ts
// registers them and drives real HTTP through the pair.
// ---------------------------------------------------------------------------

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @Roles('admin')
  @Get('admin-only')
  adminOnly(@CurrentActor() actor: AuthenticatedActor) {
    return { id: actor.id, level: actor.level };
  }

  @Roles('patient')
  @Get('patient-only')
  patientOnly() {
    return { ok: true };
  }
}

describe('AuthGuard and RolesGuard together', () => {
  let app: INestApplication;
  let server: FastifyInstance;
  let tokens: TokensService;

  beforeAll(async () => {
    resetEnvironment();
    validateEnvironment({ ...ENVIRONMENT });

    const admin = { id: 'admin-1', status: 'active', tokenVersion: 0, permissionLevel: 'finance' };
    const prisma = {
      admin: { findUnique: vi.fn().mockResolvedValue(admin) },
      patient: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        Reflector,
        AccountsService,
        TokensService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        // Registration order mirrors app.module.ts: identity first, then common.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    server = app.getHttpAdapter().getInstance() as FastifyInstance;
    await server.ready();
    tokens = moduleRef.get(TokensService);
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, token?: string) =>
    server.inject({
      method: 'GET',
      url: path,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  it('serves a public route with no token', async () => {
    expect((await get('/probe/open')).statusCode).toBe(200);
  });

  it('lets a valid admin token reach a @Roles route, proving AuthGuard ran first', async () => {
    const pair = await tokens.issue({
      id: 'admin-1',
      type: 'admin',
      tokenVersion: 0,
      level: 'finance',
    });
    const response = await get('/probe/admin-only', pair.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string; level: string }>()).toEqual({
      id: 'admin-1',
      level: 'finance',
    });
  });

  it('refuses an admin token on a patient-only route: the wrong app for the account', async () => {
    const pair = await tokens.issue({
      id: 'admin-1',
      type: 'admin',
      tokenVersion: 0,
      level: 'finance',
    });
    const response = await get('/probe/patient-only', pair.accessToken);

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('FORBIDDEN');
  });

  it('refuses a protected route with no token at all', async () => {
    expect((await get('/probe/admin-only')).statusCode).toBe(401);
  });
});

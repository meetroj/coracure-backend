import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';

import { AppModule } from './app.module';
import { registerWebhookJsonParser } from './common/webhook-body';
import { registerStubUploadParser } from './storage/stub-upload-parser';
import { AuditService } from './audit/audit.service';
import { env } from './config/env.validation';

/** An inbound correlation id is echoed back, but never trusted at arbitrary length. */
function requestId(request: IncomingMessage | Http2ServerRequest): string {
  const header = request.headers['x-request-id'];
  const supplied = Array.isArray(header) ? header[0] : header;
  return supplied ? supplied.slice(0, 64) : randomUUID();
}

async function bootstrap(): Promise<void> {
  // Reads and validates the environment before anything is constructed.
  const config = env();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // TLS terminates at the load balancer; without this the client IP written
      // to the audit log would be the balancer's.
      trustProxy: config.TRUST_PROXY,
      genReqId: requestId,
      logger: {
        level: config.LOG_LEVEL,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
      },
    }),
    // The payment webhook verifies an HMAC over the exact bytes received (M-12),
    // and the LiveKit webhook a signature over a hash of them (M-14).
    { rawBody: true },
  );

  registerWebhookJsonParser(app);
  // Only with the stub provider: the sink route that stands in for the bucket
  // receives file bytes, and Fastify refuses those content types by default.
  if (config.STORAGE_PROVIDER === 'stub') registerStubUploadParser(app);

  await app.register(helmet);
  const origins = config.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.includes('*') ? true : origins,
    credentials: !origins.includes('*'),
  });

  app.setGlobalPrefix(config.API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      /**
       * *** WITHOUT THIS, EVERY NUMERIC AND BOOLEAN QUERY PARAM IS REJECTED. ***
       *
       * A query string carries only text: `?limit=100` arrives as the STRING
       * "100", and `@IsInt()` refuses it. `transform: true` alone does not fix
       * that - it builds the DTO instance but leaves primitives as they came.
       *
       * The result was that every filter in the admin panel failed with
       * "limit must be an integer number": the payment export, the safety-alert
       * queue, the Care Hub shelf, the complaint queue and the audit search,
       * across 47 validators in 13 DTO files. Bodies were unaffected, because
       * JSON carries real types - which is exactly why it survived to here.
       *
       * The cost is that a body field declared `string` would now accept a
       * number and coerce it. That is a real weakening, and it is worth it
       * against the alternative of a `@Type()` decorator on 47 fields that
       * somebody has to remember on the forty-eighth.
       */
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableShutdownHooks();

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header('x-request-id', request.id);
      done();
    });

  if (config.SWAGGER_ENABLED ?? config.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Coracure API')
        .setDescription('Backend API for the Coracure consultation platform')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.PORT, config.HOST);

  // Proof of life in the trail every module writes to (MODULES M-01).
  await app.get(AuditService).record({
    actorType: 'system',
    action: 'create',
    entityType: 'service',
    entityId: 'api',
    metadata: { nodeEnv: config.NODE_ENV, pid: process.pid },
  });
}

void bootstrap();

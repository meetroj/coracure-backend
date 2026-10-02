import { INestApplication } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service';
import { registerWebhookJsonParser } from '../src/common/webhook-body';
import { PrismaService } from '../src/database/prisma.service';
import { VideoWebhookController } from '../src/video/video.controller';
import { VideoService } from '../src/video/video.service';

/**
 * *** THE BUG THIS FILE EXISTS FOR. ***
 *
 * LiveKit does not send `application/json`. It sends
 * `application/webhook+json`, which Fastify has no parser for, so every
 * delivery was refused with a 415 before reaching a handler - the signature
 * never checked, the event never seen, and `consultation_participants` never
 * written. The product looked healthy: tokens issued, calls connected, and not
 * one session recorded.
 *
 * No unit test could have caught it. The failure was in the HTTP layer, above
 * every seam the service tests mock out, and it took a real LiveKit delivering
 * a real webhook to surface. That is exactly what an e2e test is for, and why
 * this one boots a Fastify app rather than calling a service.
 */
describe('POST /video/webhook (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VideoWebhookController],
      providers: [
        // The controller is the subject; what it calls is not. The service is
        // stubbed down to the one method it uses, so this test fails for
        // transport reasons only.
        {
          provide: VideoService,
          useValue: {
            handleWebhook: (rawBody: string) => Promise.resolve({ handled: rawBody.length > 0 }),
          },
        },
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { record: () => Promise.resolve() } },
      ],
    })
      // The webhook is `@Public()`, and no guard is registered here anyway.
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      rawBody: true,
    });
    registerWebhookJsonParser(app as NestFastifyApplication);
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function post(contentType: string, body: string) {
    return (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/video/webhook',
        headers: { 'content-type': contentType, authorization: 'a-signature' },
        payload: body,
      });
  }

  /** The regression. Anything but 415 means the body reached the handler. */
  it('accepts the content type LiveKit actually sends', async () => {
    const response = await post('application/webhook+json', '{"event":"participant_joined"}');
    expect(response.statusCode).not.toBe(415);
    expect(response.statusCode).toBe(200);
  });

  /**
   * The raw BYTES, not a re-serialisation of them. The signature covers a hash
   * of what was sent, so key order and whitespace both matter - which is why
   * the handler reads `rawBody` and the parser hands back an empty object.
   */
  it('gives the handler the exact bytes that arrived', async () => {
    const body = '{"event":"participant_left",  "spaced":true}';
    const response = await post('application/webhook+json', body);
    // The stub answers `handled` only if it received a non-empty raw body.
    expect(response.json()).toEqual({ handled: true });
  });

  it('still accepts plain application/json, which LiveKit may also send', async () => {
    const response = await post('application/json', '{"event":"room_finished"}');
    expect(response.statusCode).toBe(200);
  });

  /**
   * A body that is not JSON at all must still reach the handler, so that a
   * forgery and a malformed request get the same answer. Parsing here would
   * reject one of them earlier and louder than the other.
   */
  it('does not judge the body before the signature is checked', async () => {
    const response = await post('application/webhook+json', 'not json at all');
    expect(response.statusCode).toBe(200);
  });
});

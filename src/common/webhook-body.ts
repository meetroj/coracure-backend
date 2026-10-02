import { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * *** LIVEKIT DOES NOT SEND `application/json`. ***
 *
 * It sends `application/webhook+json`, which Fastify has no parser for, so
 * every delivery was refused with a 415 before reaching a handler - the
 * signature never checked, the event never seen, and `consultation_participants`
 * never written. The failure is silent from the inside: tokens issue, calls
 * connect, and not one session is recorded, with nothing in our own logs to say
 * why, because the request died in the parser above every line of M-14's code.
 *
 * The body is captured as the RAW bytes and nothing else. It is deliberately
 * NOT parsed here: the handler verifies a signature over those bytes and reads
 * the event through LiveKit's own decoder, so parsing would only add a second
 * way to fail. It also keeps the promise the controller makes - a malformed
 * body and a forged one get the same answer, where JSON parsing would reject
 * one of them earlier and more loudly than the other.
 *
 * This lives apart from `main.ts` so that a test can register it without
 * importing a module whose last line boots the whole service.
 */
export function registerWebhookJsonParser(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      'application/webhook+json',
      { parseAs: 'buffer' },
      (request, body: Buffer, done) => {
        (request as { rawBody?: Buffer }).rawBody = body;
        done(null, {});
      },
    );
}

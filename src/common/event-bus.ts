import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * The shared event map. A module declares its own events by merging into this
 * interface, so publishers and subscribers stay type-checked without importing
 * each other (MODULES 7: modules talk by a published interface or by an event):
 *
 *   declare module '../common/event-bus' {
 *     interface PlatformEvents {
 *       'consultation.booked': { consultationId: string };
 *     }
 *   }
 *
 * Subscribers listen with `@OnEvent('consultation.booked')`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PlatformEvents {}

@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Fire and forget. A failing subscriber is logged and never breaks the
   * publisher, so an event is never the reason a request fails.
   */
  publish<K extends Extract<keyof PlatformEvents, string>>(event: K, payload: PlatformEvents[K]): void {
    void this.emitter
      .emitAsync(event, payload)
      .catch((error: unknown) => this.logger.error({ event, err: error }, 'Event handler failed'));
  }
}

import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { EventBus } from './event-bus';
import { HttpExceptionFilter } from './http-exception.filter';
import { RolesGuard } from './roles.guard';

/** The cross-cutting pieces every module relies on: one error shape, role checks, events. */
@Global()
@Module({
  providers: [
    EventBus,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [EventBus],
})
export class CommonModule {}

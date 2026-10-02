import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { InboxQueryDto } from '../../notifications/dto/notification.dto';
import { ListConsultationsQueryDto } from './booking.dto';

// The app's own pipe options (main.ts): implicit conversion turns the query text 'false' into true
// before a @Transform sees it, so these have to read the raw value.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const parse = <T>(type: new () => T, query: object) =>
  pipe.transform(query, { type: 'query', metatype: type }) as Promise<T>;

describe('boolean query filters through the real pipe', () => {
  it('upcoming=false asks for what has been, and omitting it still means upcoming', async () => {
    expect((await parse(ListConsultationsQueryDto, { upcoming: 'false' })).upcoming).toBe(false);
    expect((await parse(ListConsultationsQueryDto, { upcoming: 'true' })).upcoming).toBe(true);
    expect((await parse(ListConsultationsQueryDto, {})).upcoming).toBeUndefined();
  });

  it('unreadOnly=false returns everything, not only the unread', async () => {
    expect((await parse(InboxQueryDto, { unreadOnly: 'false' })).unreadOnly).toBe(false);
    expect((await parse(InboxQueryDto, { unreadOnly: 'true' })).unreadOnly).toBe(true);
  });
});

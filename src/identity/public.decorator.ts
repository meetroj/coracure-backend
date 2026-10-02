import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'platform:public';

/**
 * Opens a route to unauthenticated callers. Authentication is DENY BY DEFAULT -
 * a new endpoint is protected unless it says otherwise here, so forgetting the
 * decorator locks a route down rather than opening it up.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

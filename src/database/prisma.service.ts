import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { env } from '../config/env.validation';

/**
 * The service's one database connection. Boot fails if the database cannot be
 * reached, and the pool is drained on shutdown. TLS is requested through the
 * connection string (`?sslmode=require`) so it is an environment decision.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(PrismaService.name);

  constructor() {
    const config = env();
    super({
      adapter: new PrismaPg(
        {
          connectionString: config.DATABASE_URL,
          max: config.DATABASE_POOL_MAX,
          connectionTimeoutMillis: config.DATABASE_TIMEOUT_MS,
        },
        {
          // A dropped idle connection must not take the process down with it.
          onPoolError: (error) => PrismaService.logger.error(error, 'Database pool error'),
        },
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    // A driver adapter connects lazily, so `$connect` alone would let the
    // service come up against an unreachable database. One real query proves it.
    await this.$queryRaw`SELECT 1`;
    PrismaService.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

import { Controller, Get, HttpStatus, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AppException, PlatformError } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { Public } from '../identity/public.decorator';

// Probes must answer before anyone has signed in.
@Public()
@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness: the process is up. Checks no dependency.' })
  live(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: the database answers, so traffic can be served.' })
  async ready(): Promise<{ status: 'ok'; database: 'up'; timestamp: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error({ err: error }, 'Readiness check failed');
      throw new AppException(
        PlatformError.DATABASE_UNAVAILABLE,
        'Service temporarily unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok', database: 'up', timestamp: new Date().toISOString() };
  }
}

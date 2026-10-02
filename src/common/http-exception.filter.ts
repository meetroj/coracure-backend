import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

import { AppException, ErrorResponse, PlatformError } from './errors';
import { env } from '../config/env.validation';

/** Prisma failures that have a meaningful HTTP answer; anything else is a 500. */
const PRISMA_STATUS: Record<string, { statusCode: HttpStatus; code: string; message: string }> = {
  P2002: {
    statusCode: HttpStatus.CONFLICT,
    code: PlatformError.CONFLICT,
    message: 'Resource already exists',
  },
  P2003: {
    statusCode: HttpStatus.CONFLICT,
    code: PlatformError.CONFLICT,
    message: 'Related resource is missing or still in use',
  },
  P2025: { statusCode: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: 'Resource not found' },
  P1001: {
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: PlatformError.DATABASE_UNAVAILABLE,
    message: 'Service temporarily unavailable',
  },
  P1008: {
    statusCode: HttpStatus.GATEWAY_TIMEOUT,
    code: PlatformError.DATABASE_UNAVAILABLE,
    message: 'Service temporarily unavailable',
  },
};

function isPrismaError(error: unknown): error is Error & { code: string; meta?: unknown } {
  return (
    error instanceof Error &&
    error.name.startsWith('PrismaClient') &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** Turns every thrown value into the single error shape (SRS 6.1: nothing internal leaks out). */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const resolved = this.resolve(exception);

    if (resolved.statusCode >= 500) {
      this.logger.error(
        { requestId: request.id, path: request.url, err: exception },
        'Unhandled request failure',
      );
    }

    const body: ErrorResponse = {
      ...resolved,
      path: request.url,
      requestId: String(request.id),
      timestamp: new Date().toISOString(),
    };
    void reply.status(resolved.statusCode).send(body);
  }

  private resolve(
    exception: unknown,
  ): Pick<ErrorResponse, 'statusCode' | 'code' | 'message'> & { details?: unknown } {
    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      const payload =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : {};
      // ValidationPipe reports one string per rejected field.
      const messages = payload.message;
      return {
        statusCode,
        code:
          typeof payload.code === 'string'
            ? payload.code
            : (HttpStatus[statusCode] ?? PlatformError.INTERNAL_ERROR),
        message: Array.isArray(messages)
          ? 'Request validation failed'
          : typeof messages === 'string'
            ? messages
            : exception.message,
        details: Array.isArray(messages) ? messages : payload.details,
      };
    }

    if (isPrismaError(exception)) {
      const mapped = PRISMA_STATUS[exception.code];
      if (mapped) return mapped;
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: PlatformError.INTERNAL_ERROR,
      // A stack or a driver message must never reach a client in production.
      message: env().NODE_ENV === 'production' ? 'Internal server error' : String(exception),
    };
  }
}

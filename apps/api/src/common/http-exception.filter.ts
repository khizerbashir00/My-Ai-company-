import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId: string;
}

/**
 * Converts every error into a safe JSON shape. Unexpected errors are logged server-side with a
 * request ID; the client only sees a generic message plus that ID — no stack traces, SQL or secrets.
 */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID();

    const body = this.toBody(exception, requestId);
    if (body.statusCode >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${requestId}] ${req.method} ${req.path} → ${err.name}: ${err.message}`, err.stack);
    }
    res.setHeader('x-request-id', requestId);
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, requestId: string): ErrorBody {
    if (exception instanceof ThrottlerException) {
      return { statusCode: 429, error: 'Too Many Requests', message: 'Too many requests — please wait a moment and try again.', requestId };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string' ? response : ((response as { message?: string | string[] }).message ?? exception.message);
      return { statusCode: status, error: HttpStatus[status] ?? 'Error', message, requestId };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') return { statusCode: 409, error: 'Conflict', message: 'A record with these details already exists.', requestId };
      if (exception.code === 'P2025') return { statusCode: 404, error: 'Not Found', message: 'Record not found.', requestId };
      if (exception.code === 'P2003') return { statusCode: 400, error: 'Bad Request', message: 'A referenced record does not exist.', requestId };
    }
    return { statusCode: 500, error: 'Internal Server Error', message: 'Something went wrong. Reference this request ID if it keeps happening.', requestId };
  }
}

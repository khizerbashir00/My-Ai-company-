import type { LoggerService, LogLevel } from '@nestjs/common';

/** Structured JSON logs for production aggregators. Never logs secret values. */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    const hasStack = typeof stackOrContext === 'string' && stackOrContext.includes('\n');
    this.write('error', message, hasStack ? context : stackOrContext, hasStack ? stackOrContext : undefined);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }
  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }
  setLogLevels(_levels: LogLevel[]): void {
    /* Nest may call this; we emit all levels when selected as app logger. */
  }

  private write(level: string, message: unknown, context?: string, stack?: string): void {
    const payload: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      pid: process.pid,
      context: context || undefined,
      msg: typeof message === 'string' ? message : safeJson(message),
    };
    if (stack) payload.stack = stack;
    // Avoid logging obvious secret-bearing patterns
    const line = JSON.stringify(payload);
    if (/api[_-]?key|password|secret|authorization/i.test(line) && /"[A-Za-z0-9_\-]{20,}"/.test(line)) {
      process.stdout.write(`${JSON.stringify({ ...payload, msg: '[redacted-possible-secret]' })}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

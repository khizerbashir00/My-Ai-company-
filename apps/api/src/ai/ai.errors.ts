/** Thrown when OPENAI_API_KEY or model names are missing. Safe for API responses (no secrets). */
export class AiCredentialsError extends Error {
  readonly code = 'AI_CREDENTIALS_MISSING' as const;
  constructor(message = 'AI provider is not configured. Set OPENAI_API_KEY and OPENAI_MODEL on the server.') {
    super(message);
    this.name = 'AiCredentialsError';
  }
}

/** Thrown when the model returns JSON that fails schema validation. */
export class AiOutputValidationError extends Error {
  readonly code = 'AI_OUTPUT_INVALID' as const;
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AiOutputValidationError';
  }
}

/** Thrown for provider/network/rate-limit failures. Message is sanitized. */
export class AiProviderError extends Error {
  readonly code = 'AI_PROVIDER_ERROR' as const;
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Thrown when a run exceeds its timeout or the task was cancelled mid-flight. */
export class AiCancelledError extends Error {
  readonly code = 'AI_CANCELLED' as const;
  constructor(message = 'AI execution was cancelled or timed out.') {
    super(message);
    this.name = 'AiCancelledError';
  }
}

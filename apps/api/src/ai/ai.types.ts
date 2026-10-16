import type { z } from 'zod';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiCompletionResult<T> {
  data: T;
  model: string;
  provider: 'openai';
  usage: AiUsage;
  /** Raw text returned by the model (never contains API keys). */
  rawText: string;
}

export interface AiStructuredRequest<T> {
  model: string;
  messages: AiMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  temperature?: number;
}

/** Provider boundary — OpenAI today, other vendors later. */
export interface AiProvider {
  readonly name: 'openai';
  completeStructured<T>(req: AiStructuredRequest<T>): Promise<AiCompletionResult<T>>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

/** Current product phase for tool availability checks. */
export const CURRENT_EXECUTION_PHASE = 6;

/** Hard cap for a single model call. */
export const AI_CALL_TIMEOUT_MS = 60_000;

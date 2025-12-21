/**
 * AWS Bedrock client for invoking AI models via Converse API
 * Supports all Bedrock models: Claude, Llama, Mistral, Titan, Cohere, AI21
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

import { withRetry } from './retry.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Bedrock client
 */
export interface BedrockClientOptions {
  region: string;
  roleArn: string;
}

/**
 * Options for invoking a model
 */
export interface InvokeModelOptions {
  modelId: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Result from model invocation including usage metrics
 */
export interface ModelInvocationResult {
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * Model pricing per 1M tokens (USD)
 * Used by calculateCost() - values come from config
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error for Bedrock operations
 */
export class BedrockError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'BedrockError';
  }
}

/**
 * Error for rate limiting / throttling
 */
export class ThrottlingError extends BedrockError {
  constructor(message: string) {
    super(message, 'ThrottlingException');
    this.name = 'ThrottlingError';
  }
}

/**
 * Error for invalid request validation
 */
export class ValidationError extends BedrockError {
  constructor(message: string) {
    super(message, 'ValidationException');
    this.name = 'ValidationError';
  }
}

/**
 * Error for model inference timeout
 */
export class ModelTimeoutError extends BedrockError {
  constructor(message: string) {
    super(message, 'ModelTimeoutException');
    this.name = 'ModelTimeoutError';
  }
}

/**
 * Error for access denied
 */
export class AccessDeniedError extends BedrockError {
  constructor(message: string) {
    super(message, 'AccessDeniedException');
    this.name = 'AccessDeniedError';
  }
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Retryable AWS error names
 */
const RETRYABLE_ERROR_NAMES = [
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'RequestTimeoutException',
  'InternalServerException',
];

// ============================================================================
// Functions
// ============================================================================

/**
 * Creates a Bedrock client with auto-detected credentials from environment.
 * AWS SDK reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
 * set by aws-actions/configure-aws-credentials GitHub Action.
 *
 * @param options - Client options (region is required, roleArn is informational)
 * @returns Configured BedrockRuntimeClient
 */
export function createBedrockClient(
  options: BedrockClientOptions
): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: options.region,
    // Credentials are auto-detected from environment variables
  });
}

/**
 * Checks if an error from Bedrock is retryable
 *
 * Retryable errors:
 * - ThrottlingException (rate limit)
 * - ServiceUnavailableException (temporary)
 * - ModelTimeoutException (inference timeout)
 * - RequestTimeoutException (request timeout)
 * - InternalServerException (server error)
 *
 * Non-retryable errors:
 * - ValidationException (invalid request)
 * - AccessDeniedException (auth failure)
 * - ModelNotReadyException (model not deployed)
 */
export function isBedrockRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Check error name property (AWS SDK errors have this)
  // AWS errors may have a code property in addition to name
  const awsError = error as Error & { code?: string };
  const errorName = awsError.code ?? error.name;

  if (RETRYABLE_ERROR_NAMES.includes(errorName)) {
    return true;
  }

  // Also check for our custom error classes
  if (error instanceof ThrottlingError || error instanceof ModelTimeoutError) {
    return true;
  }

  return false;
}

/**
 * Invokes a model on Bedrock using the Converse API
 * This unified API works with all Bedrock models: Claude, Llama, Mistral, Titan, etc.
 *
 * @param client - BedrockRuntimeClient instance
 * @param options - Invocation options
 * @returns Model response with usage metrics
 * @throws BedrockError subclasses for specific error types
 */
export async function invokeModel(
  client: BedrockRuntimeClient,
  options: InvokeModelOptions
): Promise<ModelInvocationResult> {
  const startTime = Date.now();

  // Use Converse API for vendor-agnostic model invocation
  const command = new ConverseCommand({
    modelId: options.modelId,
    messages: [
      {
        role: 'user',
        content: [{ text: options.prompt }],
      },
    ],
    inferenceConfig: {
      maxTokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
    },
  });

  // Execute with retry (jitter enabled for Bedrock calls)
  const result = await withRetry(
    async () => {
      try {
        return await client.send(command);
      } catch (error) {
        // Transform AWS errors to our error types for better handling
        throw transformBedrockError(error);
      }
    },
    {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      jitter: true,
    },
    isBedrockRetryableError
  );

  const latencyMs = Date.now() - startTime;

  // Parse Converse API response
  const responseText = extractResponseText(result);

  return {
    response: responseText,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    latencyMs,
  };
}

/**
 * Extracts text content from Converse API response
 */
function extractResponseText(result: ConverseCommandOutput): string {
  const content = result.output?.message?.content;

  if (!content || content.length === 0) {
    return '';
  }

  // Concatenate all text blocks from the response
  return content
    .filter(
      (block): block is { text: string } =>
        'text' in block && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('');
}

/**
 * Transforms AWS SDK errors to our custom error types
 */
function transformBedrockError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new BedrockError(String(error), 'UnknownError');
  }

  switch (error.name) {
    case 'ThrottlingException':
      return new ThrottlingError(error.message);
    case 'ValidationException':
      return new ValidationError(error.message);
    case 'ModelTimeoutException':
    case 'RequestTimeoutException':
      return new ModelTimeoutError(error.message);
    case 'AccessDeniedException':
      return new AccessDeniedError(error.message);
    default:
      // Return original error for other cases
      return error;
  }
}

/**
 * Calculates the cost in USD for a model invocation
 *
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param pricing - Pricing configuration from config
 * @returns Cost in USD (rounded to 6 decimal places)
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;

  // Round to 6 decimal places
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

// Re-export types for external use
export type { BedrockRuntimeClient, ConverseCommandOutput };

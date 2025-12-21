/**
 * Exponential backoff and retry logic for API calls
 */

import * as core from '@actions/core';

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay in milliseconds (doubles each attempt) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (cap for exponential growth) */
  maxDelayMs: number;
  /** Add random jitter (0-25% of delay) to prevent thundering herd */
  jitter?: boolean;
}

/**
 * Default retry configuration
 * Delays: 1s, 2s, 4s, 8s (capped)
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculates delay for retry attempt using exponential backoff
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param jitter - Add random jitter (0-25% of delay) to prevent thundering herd
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter = false
): number {
  // Exponential: baseDelay * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  if (jitter) {
    // Add random jitter: 0-25% of delay
    const jitterAmount = cappedDelay * Math.random() * 0.25;
    return Math.floor(cappedDelay + jitterAmount);
  }

  return cappedDelay;
}

/**
 * Checks if an error is retryable based on its type and status code
 *
 * Retryable errors:
 * - Rate limit errors (403 with rate limit headers)
 * - Server errors (5xx)
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 *
 * Non-retryable errors:
 * - Client errors (4xx except 403 rate limit, 408, 429)
 * - Validation errors (422)
 * - Authentication errors (401)
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Check for Octokit/HTTP errors with status codes
  const httpError = error as Error & {
    status?: number;
    response?: { status?: number };
  };
  const statusCode = httpError.status ?? httpError.response?.status;

  if (statusCode !== undefined) {
    // Rate limit (403) and too many requests (429) are retryable
    if (statusCode === 403 || statusCode === 429) {
      return true;
    }

    // Request timeout is retryable
    if (statusCode === 408) {
      return true;
    }

    // Server errors are retryable
    if (statusCode >= 500 && statusCode < 600) {
      return true;
    }

    // Other client errors are not retryable
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }

  // Network errors are retryable
  const networkError = error as Error & { code?: string };
  const networkErrorCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
  ];

  if (
    networkError.code !== undefined &&
    networkErrorCodes.includes(networkError.code)
  ) {
    return true;
  }

  return false;
}

/**
 * Extracts retry-after header value from error response
 *
 * @param error - Error from API call
 * @returns Retry delay in milliseconds, or undefined if not present
 */
export function extractRetryAfter(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const httpError = error as Error & {
    response?: {
      headers?: {
        'retry-after'?: string;
        'x-ratelimit-reset'?: string;
      };
    };
  };

  const headers = httpError.response?.headers;
  if (headers === undefined) {
    return undefined;
  }

  // Check retry-after header (in seconds)
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }
  }

  // Check x-ratelimit-reset header (Unix timestamp)
  const rateLimitReset = headers['x-ratelimit-reset'];
  if (rateLimitReset !== undefined) {
    const resetTime = parseInt(rateLimitReset, 10) * 1000;
    const now = Date.now();
    if (!isNaN(resetTime) && resetTime > now) {
      return resetTime - now;
    }
  }

  return undefined;
}

/**
 * Executes a function with exponential backoff on retryable failures
 *
 * @param fn - Async function to execute
 * @param config - Retry configuration (optional, uses defaults)
 * @param shouldRetry - Custom function to determine if error is retryable (optional)
 * @returns Result of the function
 * @throws Last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => octokit.rest.pulls.listFiles({ owner, repo, pull_number }),
 *   { maxRetries: 3 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  shouldRetry?: (error: unknown) => boolean
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, jitter } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  const retryCheck = shouldRetry ?? isRetryableError;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt >= maxRetries || !retryCheck(error)) {
        throw error;
      }

      // Calculate delay (use retry-after header if available)
      const retryAfterMs = extractRetryAfter(error);
      const backoffMs = calculateBackoffDelay(
        attempt,
        baseDelayMs,
        maxDelayMs,
        jitter ?? false
      );
      const delayMs =
        retryAfterMs !== undefined
          ? Math.max(retryAfterMs, backoffMs)
          : backoffMs;

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      core.warning(
        `Attempt ${String(attempt + 1)}/${String(maxRetries + 1)} failed: ${errorMessage}. ` +
          `Retrying in ${String(delayMs)}ms...`
      );

      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

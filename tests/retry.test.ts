import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  calculateBackoffDelay,
  DEFAULT_RETRY_CONFIG,
  extractRetryAfter,
  isRetryableError,
  sleep,
  withRetry,
} from '../src/retry';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  warning: vi.fn(),
}));

describe('DEFAULT_RETRY_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(8000);
  });
});

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after specified milliseconds', async () => {
    const promise = sleep(1000);
    vi.advanceTimersByTime(999);

    // Should not have resolved yet
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();

    expect(resolved).toBe(true);
  });
});

describe('calculateBackoffDelay', () => {
  it('calculates exponential delays', () => {
    expect(calculateBackoffDelay(0, 1000, 8000)).toBe(1000);
    expect(calculateBackoffDelay(1, 1000, 8000)).toBe(2000);
    expect(calculateBackoffDelay(2, 1000, 8000)).toBe(4000);
    expect(calculateBackoffDelay(3, 1000, 8000)).toBe(8000);
  });

  it('caps at maxDelayMs', () => {
    expect(calculateBackoffDelay(4, 1000, 8000)).toBe(8000);
    expect(calculateBackoffDelay(10, 1000, 8000)).toBe(8000);
  });

  it('works with different base delays', () => {
    expect(calculateBackoffDelay(0, 500, 4000)).toBe(500);
    expect(calculateBackoffDelay(1, 500, 4000)).toBe(1000);
    expect(calculateBackoffDelay(2, 500, 4000)).toBe(2000);
    expect(calculateBackoffDelay(3, 500, 4000)).toBe(4000);
    expect(calculateBackoffDelay(4, 500, 4000)).toBe(4000);
  });
});

describe('isRetryableError', () => {
  it('returns false for non-Error values', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('error')).toBe(false);
    expect(isRetryableError(123)).toBe(false);
  });

  it('returns true for rate limit errors (403)', () => {
    const error = Object.assign(new Error('Rate limited'), { status: 403 });
    expect(isRetryableError(error)).toBe(true);
  });

  it('returns true for too many requests (429)', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
    });
    expect(isRetryableError(error)).toBe(true);
  });

  it('returns true for request timeout (408)', () => {
    const error = Object.assign(new Error('Request timeout'), { status: 408 });
    expect(isRetryableError(error)).toBe(true);
  });

  it('returns true for server errors (5xx)', () => {
    expect(
      isRetryableError(
        Object.assign(new Error('Server error'), { status: 500 })
      )
    ).toBe(true);
    expect(
      isRetryableError(Object.assign(new Error('Bad gateway'), { status: 502 }))
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(new Error('Service unavailable'), { status: 503 })
      )
    ).toBe(true);
  });

  it('returns false for client errors (4xx except 403, 408, 429)', () => {
    expect(
      isRetryableError(Object.assign(new Error('Bad request'), { status: 400 }))
    ).toBe(false);
    expect(
      isRetryableError(
        Object.assign(new Error('Unauthorized'), { status: 401 })
      )
    ).toBe(false);
    expect(
      isRetryableError(Object.assign(new Error('Not found'), { status: 404 }))
    ).toBe(false);
    expect(
      isRetryableError(
        Object.assign(new Error('Validation error'), { status: 422 })
      )
    ).toBe(false);
  });

  it('returns true for network errors', () => {
    expect(
      isRetryableError(
        Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })
      )
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })
      )
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' })
      )
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(new Error('Not found'), { code: 'ENOTFOUND' })
      )
    ).toBe(true);
  });

  it('returns false for unknown errors', () => {
    expect(isRetryableError(new Error('Unknown error'))).toBe(false);
  });

  it('handles errors with response.status', () => {
    const error = Object.assign(new Error('API error'), {
      response: { status: 500 },
    });
    expect(isRetryableError(error)).toBe(true);
  });
});

describe('extractRetryAfter', () => {
  it('returns undefined for non-Error values', () => {
    expect(extractRetryAfter(null)).toBeUndefined();
    expect(extractRetryAfter('error')).toBeUndefined();
  });

  it('returns undefined when no headers present', () => {
    expect(extractRetryAfter(new Error('No response'))).toBeUndefined();
    expect(
      extractRetryAfter(
        Object.assign(new Error('No headers'), { response: {} })
      )
    ).toBeUndefined();
  });

  it('extracts retry-after header in seconds', () => {
    const error = Object.assign(new Error('Rate limited'), {
      response: {
        headers: {
          'retry-after': '60',
        },
      },
    });
    expect(extractRetryAfter(error)).toBe(60000); // 60 seconds in ms
  });

  it('extracts x-ratelimit-reset header', () => {
    const futureTime = Math.floor(Date.now() / 1000) + 30; // 30 seconds from now
    const error = Object.assign(new Error('Rate limited'), {
      response: {
        headers: {
          'x-ratelimit-reset': String(futureTime),
        },
      },
    });

    const result = extractRetryAfter(error);
    expect(result).toBeGreaterThan(25000); // Should be close to 30000ms
    expect(result).toBeLessThanOrEqual(30000);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withRetry(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Server error'), { status: 500 })
      )
      .mockResolvedValue('success');

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
    });

    // Advance timer for first retry
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-retryable error', async () => {
    const error = Object.assign(new Error('Not found'), { status: 404 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toThrow('Not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after max retries exceeded', async () => {
    const error = Object.assign(new Error('Server error'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(error);

    // Start the promise and immediately attach the error handler
    const promise = withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 400,
    }).catch((e: unknown) => e);

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(100); // First retry
    await vi.advanceTimersByTimeAsync(200); // Second retry

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Server error');
    expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('uses custom shouldRetry function', async () => {
    const error = new Error('Custom error');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');

    const shouldRetry = vi.fn().mockReturnValue(true);

    const promise = withRetry(
      fn,
      { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100 },
      shouldRetry
    );

    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe('success');
    expect(shouldRetry).toHaveBeenCalledWith(error);
  });

  it('applies exponential backoff delays', async () => {
    const error = Object.assign(new Error('Server error'), { status: 500 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
    });

    // First retry after 1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second retry after 2s
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    // Third retry after 4s
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(4);

    const result = await promise;
    expect(result).toBe('success');
  });
});

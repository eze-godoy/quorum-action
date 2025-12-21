import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  AccessDeniedError,
  BedrockError,
  calculateCost,
  createBedrockClient,
  invokeModel,
  isBedrockRetryableError,
  ModelTimeoutError,
  ThrottlingError,
  ValidationError,
  type BedrockRuntimeClient,
  type ModelPricing,
} from '../src/bedrock';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  warning: vi.fn(),
}));

// Mock @aws-sdk/client-bedrock-runtime
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation((config: unknown) => ({
    _config: config,
    send: vi.fn(),
  })),
  ConverseCommand: vi.fn().mockImplementation((input: unknown) => ({
    _input: input,
  })),
}));

// Mock retry module to avoid actual delays in tests
vi.mock('../src/retry', () => ({
  withRetry: vi.fn(
    (fn: () => unknown, _config?: unknown, _shouldRetry?: unknown) => fn()
  ),
}));

describe('Error Classes', () => {
  describe('BedrockError', () => {
    it('creates error with code', () => {
      const error = new BedrockError('Test error', 'TestCode');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TestCode');
      expect(error.name).toBe('BedrockError');
    });
  });

  describe('ThrottlingError', () => {
    it('creates throttling error', () => {
      const error = new ThrottlingError('Rate limited');
      expect(error.message).toBe('Rate limited');
      expect(error.code).toBe('ThrottlingException');
      expect(error.name).toBe('ThrottlingError');
    });
  });

  describe('ValidationError', () => {
    it('creates validation error', () => {
      const error = new ValidationError('Invalid request');
      expect(error.message).toBe('Invalid request');
      expect(error.code).toBe('ValidationException');
      expect(error.name).toBe('ValidationError');
    });
  });

  describe('ModelTimeoutError', () => {
    it('creates timeout error', () => {
      const error = new ModelTimeoutError('Timeout');
      expect(error.message).toBe('Timeout');
      expect(error.code).toBe('ModelTimeoutException');
      expect(error.name).toBe('ModelTimeoutError');
    });
  });

  describe('AccessDeniedError', () => {
    it('creates access denied error', () => {
      const error = new AccessDeniedError('Forbidden');
      expect(error.message).toBe('Forbidden');
      expect(error.code).toBe('AccessDeniedException');
      expect(error.name).toBe('AccessDeniedError');
    });
  });
});

describe('createBedrockClient', () => {
  it('creates client with specified region', () => {
    const client = createBedrockClient({
      region: 'us-west-2',
      roleArn: 'arn:aws:iam::123456789012:role/test-role',
    });

    expect(client).toBeDefined();
    expect(
      (client as unknown as { _config: { region: string } })._config.region
    ).toBe('us-west-2');
  });
});

describe('isBedrockRetryableError', () => {
  it('returns false for non-Error values', () => {
    expect(isBedrockRetryableError(null)).toBe(false);
    expect(isBedrockRetryableError(undefined)).toBe(false);
    expect(isBedrockRetryableError('error')).toBe(false);
    expect(isBedrockRetryableError(123)).toBe(false);
  });

  it('returns true for ThrottlingException', () => {
    const error = Object.assign(new Error('Rate limited'), {
      name: 'ThrottlingException',
    });
    expect(isBedrockRetryableError(error)).toBe(true);
  });

  it('returns true for ServiceUnavailableException', () => {
    const error = Object.assign(new Error('Service unavailable'), {
      name: 'ServiceUnavailableException',
    });
    expect(isBedrockRetryableError(error)).toBe(true);
  });

  it('returns true for ModelTimeoutException', () => {
    const error = Object.assign(new Error('Timeout'), {
      name: 'ModelTimeoutException',
    });
    expect(isBedrockRetryableError(error)).toBe(true);
  });

  it('returns true for InternalServerException', () => {
    const error = Object.assign(new Error('Internal server error'), {
      name: 'InternalServerException',
    });
    expect(isBedrockRetryableError(error)).toBe(true);
  });

  it('returns false for ValidationException', () => {
    const error = Object.assign(new Error('Invalid request'), {
      name: 'ValidationException',
    });
    expect(isBedrockRetryableError(error)).toBe(false);
  });

  it('returns false for AccessDeniedException', () => {
    const error = Object.assign(new Error('Access denied'), {
      name: 'AccessDeniedException',
    });
    expect(isBedrockRetryableError(error)).toBe(false);
  });

  it('returns true for custom ThrottlingError', () => {
    const error = new ThrottlingError('Rate limited');
    expect(isBedrockRetryableError(error)).toBe(true);
  });

  it('returns true for custom ModelTimeoutError', () => {
    const error = new ModelTimeoutError('Timeout');
    expect(isBedrockRetryableError(error)).toBe(true);
  });

  it('returns false for generic Error', () => {
    const error = new Error('Unknown error');
    expect(isBedrockRetryableError(error)).toBe(false);
  });
});

describe('invokeModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes model with correct parameters using Converse API', async () => {
    // Converse API response format
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Hello, world!' }],
        },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    };

    const mockClient = {
      send: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as BedrockRuntimeClient;

    const result = await invokeModel(mockClient, {
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      prompt: 'Say hello',
    });

    expect(result.response).toBe('Hello, world!');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses default maxTokens and temperature', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Response' }],
        },
      },
      usage: { inputTokens: 5, outputTokens: 3 },
    };

    const sendMock = vi.fn().mockResolvedValue(mockResponse);
    const mockClient = { send: sendMock } as unknown as BedrockRuntimeClient;

    await invokeModel(mockClient, {
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      prompt: 'Test prompt',
    });

    // The defaults are applied in the request (maxTokens: 4096, temperature: 0.3)
    expect(sendMock).toHaveBeenCalled();
  });

  it('handles custom maxTokens and temperature', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Response' }],
        },
      },
      usage: { inputTokens: 5, outputTokens: 3 },
    };

    const sendMock = vi.fn().mockResolvedValue(mockResponse);
    const mockClient = { send: sendMock } as unknown as BedrockRuntimeClient;

    await invokeModel(mockClient, {
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      prompt: 'Test prompt',
      maxTokens: 2048,
      temperature: 0.7,
    });

    expect(sendMock).toHaveBeenCalled();
  });

  it('concatenates multiple text content blocks', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Part 1' }, { text: 'Part 2' }],
        },
      },
      usage: { inputTokens: 10, outputTokens: 8 },
    };

    const mockClient = {
      send: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as BedrockRuntimeClient;

    const result = await invokeModel(mockClient, {
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      prompt: 'Test',
    });

    expect(result.response).toBe('Part 1Part 2');
  });

  it('returns empty string for empty content', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [],
        },
      },
      usage: { inputTokens: 5, outputTokens: 0 },
    };

    const mockClient = {
      send: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as BedrockRuntimeClient;

    const result = await invokeModel(mockClient, {
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      prompt: 'Test',
    });

    expect(result.response).toBe('');
  });

  it('returns empty string for missing content', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
        },
      },
      usage: { inputTokens: 5, outputTokens: 0 },
    };

    const mockClient = {
      send: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as BedrockRuntimeClient;

    const result = await invokeModel(mockClient, {
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      prompt: 'Test',
    });

    expect(result.response).toBe('');
  });

  it('handles missing usage metrics gracefully', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Response' }],
        },
      },
      // No usage field
    };

    const mockClient = {
      send: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as BedrockRuntimeClient;

    const result = await invokeModel(mockClient, {
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      prompt: 'Test',
    });

    expect(result.response).toBe('Response');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe('calculateCost', () => {
  // Default pricing (Claude 3.5 Sonnet rates)
  const sonnetPricing: ModelPricing = { inputPer1M: 3.0, outputPer1M: 15.0 };
  const haikuPricing: ModelPricing = { inputPer1M: 0.25, outputPer1M: 1.25 };
  const opusPricing: ModelPricing = { inputPer1M: 15.0, outputPer1M: 75.0 };

  it('calculates costs with Sonnet pricing', () => {
    // 1000 input tokens at $3/1M = $0.003
    // 500 output tokens at $15/1M = $0.0075
    // Total: $0.0105
    const cost = calculateCost(1000, 500, sonnetPricing);
    expect(cost).toBe(0.0105);
  });

  it('calculates costs with Haiku pricing', () => {
    // 1000 input tokens at $0.25/1M = $0.00025
    // 500 output tokens at $1.25/1M = $0.000625
    // Total: $0.000875
    const cost = calculateCost(1000, 500, haikuPricing);
    expect(cost).toBe(0.000875);
  });

  it('calculates costs with Opus pricing', () => {
    // 1000 input tokens at $15/1M = $0.015
    // 500 output tokens at $75/1M = $0.0375
    // Total: $0.0525
    const cost = calculateCost(1000, 500, opusPricing);
    expect(cost).toBe(0.0525);
  });

  it('calculates costs with custom pricing', () => {
    // Custom pricing for Llama or other models
    const llamaPricing: ModelPricing = { inputPer1M: 0.99, outputPer1M: 0.99 };
    // 1000 input at $0.99/1M = $0.00099
    // 500 output at $0.99/1M = $0.000495
    // Total: $0.001485
    const cost = calculateCost(1000, 500, llamaPricing);
    expect(cost).toBe(0.001485);
  });

  it('handles zero tokens', () => {
    const cost = calculateCost(0, 0, sonnetPricing);
    expect(cost).toBe(0);
  });

  it('handles large token counts', () => {
    // 1M input tokens at $3/1M = $3
    // 500K output tokens at $15/1M = $7.5
    // Total: $10.5
    const cost = calculateCost(1_000_000, 500_000, sonnetPricing);
    expect(cost).toBe(10.5);
  });

  it('rounds to 6 decimal places', () => {
    // Small token count that would produce many decimals
    const cost = calculateCost(1, 1, sonnetPricing);
    // 1 input at $3/1M = $0.000003
    // 1 output at $15/1M = $0.000015
    // Total: $0.000018
    expect(cost).toBe(0.000018);
    expect(cost.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });
});

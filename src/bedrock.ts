/**
 * AWS Bedrock client for invoking AI models via OIDC authentication
 *
 * This module will be implemented in FORGE-54
 */

import type {
  BedrockRuntimeClient,
  InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

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

export type { BedrockRuntimeClient, InvokeModelCommandOutput };

// TODO: Implement in FORGE-54
// - createBedrockClient(options: BedrockClientOptions)
// - invokeModel(client, options: InvokeModelOptions): Promise<ModelInvocationResult>
// - calculateCost(modelId, inputTokens, outputTokens): number
// - retryWithBackoff(fn, maxRetries)

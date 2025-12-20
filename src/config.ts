import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as core from '@actions/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Review depth profiles that control the thoroughness of code review
 */
export const ReviewDepthSchema = z.enum([
  'quick',
  'standard',
  'deep',
  'security',
]);
export type ReviewDepth = z.infer<typeof ReviewDepthSchema>;

/**
 * Path-based instruction overrides for specific file patterns
 */
export const PathOverrideSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files'),
  instructions: z
    .string()
    .optional()
    .describe('Additional review instructions for matched files'),
  ignore: z
    .boolean()
    .optional()
    .default(false)
    .describe('Skip review for matched files'),
  depth: ReviewDepthSchema.optional().describe(
    'Override review depth for matched files'
  ),
});
export type PathOverride = z.infer<typeof PathOverrideSchema>;

/**
 * Main Quorum configuration schema
 */
export const QuorumConfigSchema = z.object({
  version: z
    .literal(1)
    .optional()
    .default(1)
    .describe('Configuration schema version'),

  review: z
    .object({
      depth: ReviewDepthSchema.optional()
        .default('standard')
        .describe('Default review depth'),
      focus: z
        .array(z.string())
        .optional()
        .default([])
        .describe('Areas to focus on during review'),
      instructions: z
        .string()
        .optional()
        .describe('Custom instructions for the AI reviewer'),
    })
    .optional()
    .default({}),

  ignore: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Glob patterns for files to ignore'),

  paths: z
    .array(PathOverrideSchema)
    .optional()
    .default([])
    .describe('Path-specific configuration overrides'),

  model: z
    .object({
      id: z.string().optional().describe('Override the Bedrock model ID'),
      maxTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .default(4096)
        .describe('Maximum tokens for model response'),
      temperature: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.3)
        .describe('Model temperature for response generation'),
    })
    .optional()
    .default({}),
});

export type QuorumConfig = z.infer<typeof QuorumConfigSchema>;

/**
 * Default configuration when no .quorum.yaml is present
 */
export const DEFAULT_CONFIG: QuorumConfig = {
  version: 1,
  review: {
    depth: 'standard',
    focus: [],
    instructions: undefined,
  },
  ignore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/coverage/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
  ],
  paths: [],
  model: {
    id: undefined,
    maxTokens: 4096,
    temperature: 0.3,
  },
};

/**
 * Load and validate Quorum configuration from a YAML file
 *
 * @param configPath - Path to the .quorum.yaml configuration file
 * @returns Validated configuration merged with defaults
 */
export async function getConfig(configPath: string): Promise<QuorumConfig> {
  const absolutePath = path.resolve(process.cwd(), configPath);

  try {
    const content = await fs.readFile(absolutePath, 'utf-8');
    const parsed: unknown = parseYaml(content);

    const result = QuorumConfigSchema.safeParse(parsed);

    if (!result.success) {
      core.warning(
        `Invalid configuration in ${configPath}: ${result.error.message}`
      );
      core.warning('Using default configuration');
      return DEFAULT_CONFIG;
    }

    // Merge with defaults for any missing optional fields
    return {
      ...DEFAULT_CONFIG,
      ...result.data,
      review: { ...DEFAULT_CONFIG.review, ...result.data.review },
      ignore: [...DEFAULT_CONFIG.ignore, ...result.data.ignore],
      paths: result.data.paths,
      model: { ...DEFAULT_CONFIG.model, ...result.data.model },
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      core.info(`No configuration file found at ${configPath}, using defaults`);
      return DEFAULT_CONFIG;
    }

    core.warning(`Error reading configuration: ${String(error)}`);
    return DEFAULT_CONFIG;
  }
}

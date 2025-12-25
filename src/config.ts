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
 * Model pricing configuration (per 1M tokens in USD)
 * Defaults to Claude 3.5 Sonnet pricing
 */
export const PricingSchema = z.object({
  inputPer1M: z
    .number()
    .positive()
    .optional()
    .default(3.0)
    .describe('Cost per 1M input tokens in USD'),
  outputPer1M: z
    .number()
    .positive()
    .optional()
    .default(15.0)
    .describe('Cost per 1M output tokens in USD'),
});
export type Pricing = z.infer<typeof PricingSchema>;

/**
 * Severity levels for filtering comments
 */
export const SeverityLevelSchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
]);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

/**
 * Default severity emoji mapping
 */
export const DEFAULT_SEVERITY_EMOJI: Record<SeverityLevel, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

/**
 * Output configuration for review comments
 */
export const OutputSchema = z.object({
  minSeverity: SeverityLevelSchema.optional()
    .default('low')
    .describe(
      'Minimum severity level to post comments (critical > high > medium > low)'
    ),
  severityEmoji: z
    .record(SeverityLevelSchema, z.string())
    .optional()
    .describe('Custom emoji mapping for severity levels'),
});
export type Output = z.infer<typeof OutputSchema>;

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

  pricing: PricingSchema.optional()
    .default({})
    .describe('Model pricing configuration for cost tracking'),

  output: OutputSchema.optional()
    .default({})
    .describe('Output configuration for review comments'),
});

export type QuorumConfig = z.infer<typeof QuorumConfigSchema>;

/**
 * Partial config schema for PR description overrides
 * All fields are optional to allow partial overrides
 */
export const PartialQuorumConfigSchema = QuorumConfigSchema.partial();

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
  pricing: {
    inputPer1M: 3.0, // Claude 3.5 Sonnet default
    outputPer1M: 15.0,
  },
  output: {
    minSeverity: 'low',
    severityEmoji: undefined,
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
      pricing: { ...DEFAULT_CONFIG.pricing, ...result.data.pricing },
      output: { ...DEFAULT_CONFIG.output, ...result.data.output },
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

/**
 * Regex pattern to extract quorum-config from PR description
 * Matches: <!-- quorum-config: {...} -->
 */
const PR_CONFIG_REGEX = /<!--\s*quorum-config:\s*(\{[\s\S]*?\})\s*-->/;

/**
 * Extracts and parses quorum configuration from PR description
 *
 * @param prBody - The PR description body text
 * @returns Parsed partial config or null if not found/invalid
 *
 * @example
 * ```markdown
 * ## Summary
 * Some PR description
 *
 * <!-- quorum-config: {"review": {"depth": "security"}} -->
 * ```
 */
export function extractPRConfig(prBody: string): Partial<QuorumConfig> | null {
  if (prBody === '') {
    return null;
  }

  const match = PR_CONFIG_REGEX.exec(prBody);
  if (match?.[1] === undefined) {
    return null;
  }

  const jsonContent = match[1];

  try {
    const parsed: unknown = JSON.parse(jsonContent);
    const result = PartialQuorumConfigSchema.safeParse(parsed);

    if (!result.success) {
      core.warning(
        `Invalid quorum-config in PR description: ${result.error.message}`
      );
      return null;
    }

    // Cast to Partial<QuorumConfig> - Zod's .partial() uses `T | undefined` for fields
    // but Partial<T> uses optional properties. The data is validated, so this is safe.
    return result.data as Partial<QuorumConfig>;
  } catch (error) {
    core.warning(
      `Failed to parse quorum-config JSON in PR description: ${String(error)}`
    );
    return null;
  }
}

/**
 * Merges PR config override with base config
 * Priority: PR config > file config
 *
 * Arrays are concatenated (PR config adds to existing)
 * Objects are deep merged (PR config overrides specific fields)
 *
 * @param base - Base configuration (from file + defaults)
 * @param override - Partial config from PR description
 * @returns Merged configuration
 */
export function mergeConfigs(
  base: QuorumConfig,
  override: Partial<QuorumConfig>
): QuorumConfig {
  return {
    ...base,
    version: override.version ?? base.version,
    review: {
      ...base.review,
      ...override.review,
      // Concat focus arrays if override has focus
      focus:
        override.review?.focus !== undefined
          ? [...base.review.focus, ...override.review.focus]
          : base.review.focus,
    },
    // Concat ignore arrays if override has ignore
    ignore:
      override.ignore !== undefined
        ? [...base.ignore, ...override.ignore]
        : base.ignore,
    // Concat paths arrays if override has paths
    paths:
      override.paths !== undefined
        ? [...base.paths, ...override.paths]
        : base.paths,
    model: {
      ...base.model,
      ...override.model,
    },
    pricing: {
      ...base.pricing,
      ...override.pricing,
    },
    output: {
      ...base.output,
      ...override.output,
    },
  };
}

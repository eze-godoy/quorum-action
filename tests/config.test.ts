import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CONFIG,
  extractPRConfig,
  getConfig,
  mergeConfigs,
  QuorumConfigSchema,
  type QuorumConfig,
} from '../src/config';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
}));

describe('QuorumConfigSchema', () => {
  it('validates a minimal valid config', () => {
    const config = {
      version: 1,
    };

    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('validates a complete valid config', () => {
    const config = {
      version: 1,
      review: {
        depth: 'deep',
        focus: ['security', 'performance'],
        instructions: 'Focus on SQL injection vulnerabilities',
      },
      ignore: ['**/*.test.ts', '**/fixtures/**'],
      paths: [
        {
          pattern: 'src/security/**',
          depth: 'security',
          instructions: 'Extra security scrutiny',
        },
        {
          pattern: '**/*.md',
          ignore: true,
        },
      ],
      model: {
        id: 'anthropic.claude-3-haiku-20240307-v1:0',
        maxTokens: 2048,
        temperature: 0.5,
      },
      pricing: {
        inputPer1M: 0.25,
        outputPer1M: 1.25,
      },
    };

    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.depth).toBe('deep');
      expect(result.data.paths).toHaveLength(2);
      expect(result.data.pricing.inputPer1M).toBe(0.25);
      expect(result.data.pricing.outputPer1M).toBe(1.25);
    }
  });

  it('uses default pricing when not specified', () => {
    const config = {
      version: 1,
    };

    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pricing.inputPer1M).toBe(3.0);
      expect(result.data.pricing.outputPer1M).toBe(15.0);
    }
  });

  it('rejects negative pricing', () => {
    const config = {
      version: 1,
      pricing: {
        inputPer1M: -1,
        outputPer1M: 15.0,
      },
    };

    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects zero pricing', () => {
    const config = {
      version: 1,
      pricing: {
        inputPer1M: 0,
        outputPer1M: 15.0,
      },
    };

    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects invalid review depth', () => {
    const config = {
      version: 1,
      review: {
        depth: 'invalid-depth',
      },
    };

    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects invalid temperature', () => {
    const config = {
      version: 1,
      model: {
        temperature: 1.5,
      },
    };

    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe('getConfig', () => {
  const testDir = path.join(process.cwd(), 'test-fixtures');

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('returns default config when file does not exist', async () => {
    const config = await getConfig('nonexistent/.quorum.yaml');
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('loads and parses a valid YAML config', async () => {
    const yamlContent = `
version: 1
review:
  depth: deep
  focus:
    - security
ignore:
  - '**/*.generated.ts'
`;
    await fs.writeFile(path.join(testDir, '.quorum.yaml'), yamlContent);

    const config = await getConfig(path.join(testDir, '.quorum.yaml'));

    expect(config.review.depth).toBe('deep');
    expect(config.review.focus).toContain('security');
    expect(config.ignore).toContain('**/*.generated.ts');
  });

  it('merges with default ignore patterns', async () => {
    const yamlContent = `
version: 1
ignore:
  - '**/*.custom.ts'
`;
    await fs.writeFile(path.join(testDir, '.quorum.yaml'), yamlContent);

    const config = await getConfig(path.join(testDir, '.quorum.yaml'));

    // Should have both default and custom ignore patterns
    expect(config.ignore).toContain('**/node_modules/**');
    expect(config.ignore).toContain('**/*.custom.ts');
  });

  it('returns default config for invalid YAML', async () => {
    const yamlContent = `
version: 1
review:
  depth: invalid-value
`;
    await fs.writeFile(path.join(testDir, '.quorum.yaml'), yamlContent);

    const config = await getConfig(path.join(testDir, '.quorum.yaml'));

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('loads custom pricing from config', async () => {
    const yamlContent = `
version: 1
pricing:
  inputPer1M: 0.99
  outputPer1M: 0.99
`;
    await fs.writeFile(path.join(testDir, '.quorum.yaml'), yamlContent);

    const config = await getConfig(path.join(testDir, '.quorum.yaml'));

    expect(config.pricing.inputPer1M).toBe(0.99);
    expect(config.pricing.outputPer1M).toBe(0.99);
  });

  it('uses default pricing when not specified in config', async () => {
    const yamlContent = `
version: 1
review:
  depth: quick
`;
    await fs.writeFile(path.join(testDir, '.quorum.yaml'), yamlContent);

    const config = await getConfig(path.join(testDir, '.quorum.yaml'));

    // Should use defaults: Claude 3.5 Sonnet pricing
    expect(config.pricing.inputPer1M).toBe(3.0);
    expect(config.pricing.outputPer1M).toBe(15.0);
  });
});

describe('extractPRConfig', () => {
  it('extracts valid config from PR body', () => {
    const prBody = `
## Summary
Some changes here

<!-- quorum-config: {"review": {"depth": "security"}} -->

More description
`;
    const result = extractPRConfig(prBody);

    expect(result).not.toBeNull();
    expect(result?.review?.depth).toBe('security');
  });

  it('extracts config with multiple fields', () => {
    const prBody = `<!-- quorum-config: {"review": {"depth": "deep", "focus": ["security"]}, "ignore": ["*.md"]} -->`;
    const result = extractPRConfig(prBody);

    expect(result).not.toBeNull();
    expect(result?.review?.depth).toBe('deep');
    expect(result?.review?.focus).toEqual(['security']);
    expect(result?.ignore).toEqual(['*.md']);
  });

  it('returns null for empty body', () => {
    expect(extractPRConfig('')).toBeNull();
  });

  it('returns null when no config comment present', () => {
    const prBody = `
## Summary
Just a regular PR description with no config
`;
    expect(extractPRConfig(prBody)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const prBody = `<!-- quorum-config: {invalid json} -->`;
    expect(extractPRConfig(prBody)).toBeNull();
  });

  it('returns null for invalid config schema', () => {
    const prBody = `<!-- quorum-config: {"review": {"depth": "invalid-depth"}} -->`;
    expect(extractPRConfig(prBody)).toBeNull();
  });

  it('handles multiline JSON config', () => {
    const prBody = `
<!-- quorum-config: {
  "review": {
    "depth": "quick",
    "instructions": "Focus on performance"
  }
} -->
`;
    const result = extractPRConfig(prBody);

    expect(result).not.toBeNull();
    expect(result?.review?.depth).toBe('quick');
    expect(result?.review?.instructions).toBe('Focus on performance');
  });

  it('handles config with extra whitespace', () => {
    const prBody = `<!--   quorum-config:   {"review": {"depth": "deep"}}   -->`;
    const result = extractPRConfig(prBody);

    expect(result).not.toBeNull();
    expect(result?.review?.depth).toBe('deep');
  });
});

describe('mergeConfigs', () => {
  const baseConfig: QuorumConfig = {
    version: 1,
    review: {
      depth: 'standard',
      focus: ['quality'],
      instructions: 'Base instructions',
    },
    ignore: ['*.log'],
    paths: [{ pattern: 'src/**', instructions: 'Check types' }],
    model: {
      id: 'base-model',
      maxTokens: 4096,
      temperature: 0.3,
    },
    pricing: {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
    },
    output: {
      minSeverity: 'low',
      severityEmoji: undefined,
    },
  };

  it('overrides scalar values from PR config', () => {
    const override = { review: { depth: 'security' as const } };
    const result = mergeConfigs(baseConfig, override);

    expect(result.review.depth).toBe('security');
    // Other values should remain
    expect(result.review.instructions).toBe('Base instructions');
  });

  it('concatenates focus arrays', () => {
    const override = { review: { focus: ['security', 'performance'] } };
    const result = mergeConfigs(baseConfig, override);

    expect(result.review.focus).toEqual(['quality', 'security', 'performance']);
  });

  it('concatenates ignore arrays', () => {
    const override = { ignore: ['*.md', '*.txt'] };
    const result = mergeConfigs(baseConfig, override);

    expect(result.ignore).toEqual(['*.log', '*.md', '*.txt']);
  });

  it('concatenates paths arrays', () => {
    const override = {
      paths: [{ pattern: 'tests/**', instructions: 'Check coverage' }],
    };
    const result = mergeConfigs(baseConfig, override);

    expect(result.paths).toHaveLength(2);
    expect(result.paths[0].pattern).toBe('src/**');
    expect(result.paths[1].pattern).toBe('tests/**');
  });

  it('deep merges model settings', () => {
    const override = { model: { temperature: 0.5 } };
    const result = mergeConfigs(baseConfig, override);

    expect(result.model.temperature).toBe(0.5);
    expect(result.model.id).toBe('base-model');
    expect(result.model.maxTokens).toBe(4096);
  });

  it('deep merges pricing settings', () => {
    const override = { pricing: { outputPer1M: 20.0 } };
    const result = mergeConfigs(baseConfig, override);

    expect(result.pricing.outputPer1M).toBe(20.0);
    expect(result.pricing.inputPer1M).toBe(3.0);
  });

  it('preserves base config when override is empty', () => {
    const result = mergeConfigs(baseConfig, {});

    expect(result).toEqual(baseConfig);
  });

  it('handles complete override', () => {
    const override: Partial<QuorumConfig> = {
      version: 1,
      review: {
        depth: 'deep',
        focus: ['docs'],
        instructions: 'New instructions',
      },
      ignore: ['*.spec.ts'],
      paths: [{ pattern: 'lib/**' }],
      model: {
        id: 'new-model',
        maxTokens: 8192,
        temperature: 0.7,
      },
      pricing: {
        inputPer1M: 1.0,
        outputPer1M: 5.0,
      },
    };
    const result = mergeConfigs(baseConfig, override);

    expect(result.review.depth).toBe('deep');
    expect(result.review.instructions).toBe('New instructions');
    // Arrays should be concatenated
    expect(result.review.focus).toEqual(['quality', 'docs']);
    expect(result.ignore).toEqual(['*.log', '*.spec.ts']);
    expect(result.paths).toHaveLength(2);
    // Objects should be merged
    expect(result.model.id).toBe('new-model');
    expect(result.pricing.inputPer1M).toBe(1.0);
  });

  it('merges output config', () => {
    const override = { output: { minSeverity: 'high' as const } };
    const result = mergeConfigs(baseConfig, override);

    expect(result.output.minSeverity).toBe('high');
    expect(result.output.severityEmoji).toBeUndefined();
  });

  it('preserves base output config when no override', () => {
    const result = mergeConfigs(baseConfig, {});

    expect(result.output.minSeverity).toBe('low');
  });
});

describe('OutputSchema', () => {
  it('has correct default minSeverity', () => {
    expect(DEFAULT_CONFIG.output.minSeverity).toBe('low');
  });

  it('has undefined severityEmoji by default', () => {
    expect(DEFAULT_CONFIG.output.severityEmoji).toBeUndefined();
  });

  it('validates minSeverity values', () => {
    const validValues = ['critical', 'high', 'medium', 'low'] as const;
    for (const value of validValues) {
      const config = { output: { minSeverity: value } };
      const result = QuorumConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid minSeverity values', () => {
    const config = { output: { minSeverity: 'invalid' } };
    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('accepts custom severityEmoji', () => {
    const config = {
      output: {
        severityEmoji: {
          critical: '❌',
          high: '⚠️',
        },
      },
    };
    const result = QuorumConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

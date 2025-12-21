import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, getConfig, QuorumConfigSchema } from '../src/config';

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

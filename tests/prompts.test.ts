import { describe, expect, it } from 'vitest';

import type { QuorumConfig } from '../src/config';
import type { ParsedPullRequestFile } from '../src/github';
import {
  buildReviewPrompt,
  DEPTH_PROFILES,
  getAvailablePromptVersions,
  getDepthProfile,
  getEffectiveDepth,
  getPromptTemplate,
  getQualityInstructions,
  getSecurityInstructions,
  getValidLineNumbers,
} from '../src/prompts';

// Test fixtures
const createMockConfig = (
  overrides: Partial<QuorumConfig> = {}
): QuorumConfig => ({
  version: 1,
  review: {
    depth: 'standard',
    focus: [],
    instructions: undefined,
  },
  ignore: [],
  paths: [],
  model: {
    id: undefined,
    maxTokens: 4096,
    temperature: 0.3,
  },
  pricing: {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  ...overrides,
});

const createMockFile = (
  overrides: Partial<ParsedPullRequestFile> = {}
): ParsedPullRequestFile => ({
  filename: 'src/index.ts',
  status: 'modified',
  additions: 5,
  deletions: 2,
  patch: '@@ -1,3 +1,5 @@\n context\n+added line\n context',
  hunks: [
    {
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 5,
      content: '@@ -1,3 +1,5 @@\n context\n+added line\n context',
      lines: [
        {
          type: 'context',
          content: 'context',
          oldLineNumber: 1,
          newLineNumber: 1,
        },
        { type: 'addition', content: 'added line', newLineNumber: 2 },
        {
          type: 'context',
          content: 'context',
          oldLineNumber: 2,
          newLineNumber: 3,
        },
      ],
    },
  ],
  ...overrides,
});

describe('getDepthProfile', () => {
  it('returns quick profile', () => {
    const profile = getDepthProfile('quick');
    expect(profile.name).toBe('quick');
    expect(profile.maxCommentsPerFile).toBe(3);
    expect(profile.instructions).toContain('Quick');
    expect(profile.instructions).toContain('Critical bugs');
  });

  it('returns standard profile', () => {
    const profile = getDepthProfile('standard');
    expect(profile.name).toBe('standard');
    expect(profile.maxCommentsPerFile).toBe(10);
    expect(profile.instructions).toContain('Standard');
  });

  it('returns deep profile', () => {
    const profile = getDepthProfile('deep');
    expect(profile.name).toBe('deep');
    expect(profile.maxCommentsPerFile).toBe(20);
    expect(profile.instructions).toContain('Thorough');
  });

  it('returns security profile', () => {
    const profile = getDepthProfile('security');
    expect(profile.name).toBe('security');
    expect(profile.instructions).toContain('OWASP');
  });

  it('all profiles have required fields', () => {
    for (const depth of ['quick', 'standard', 'deep', 'security'] as const) {
      const profile = DEPTH_PROFILES[depth];
      expect(profile.name).toBe(depth);
      expect(profile.description).toBeDefined();
      expect(profile.instructions.length).toBeGreaterThan(0);
      expect(profile.maxCommentsPerFile).toBeGreaterThan(0);
    }
  });
});

describe('getPromptTemplate', () => {
  it('returns default template when no version specified', () => {
    const template = getPromptTemplate();
    expect(template.version).toBe('1.0.0');
    expect(template.name).toBe('standard-review-v1');
  });

  it('returns specific version when requested', () => {
    const template = getPromptTemplate('1.0.0');
    expect(template.version).toBe('1.0.0');
  });

  it('returns default for unknown version', () => {
    const template = getPromptTemplate('99.99.99');
    expect(template.version).toBe('1.0.0');
  });

  it('template has required fields', () => {
    const template = getPromptTemplate();
    expect(template.systemPrompt).toBeDefined();
    expect(template.systemPrompt.length).toBeGreaterThan(100);
    expect(template.userPromptTemplate).toBeDefined();
    expect(template.userPromptTemplate).toContain('{{DEPTH_INSTRUCTIONS}}');
    expect(template.userPromptTemplate).toContain('{{SECURITY_INSTRUCTIONS}}');
    expect(template.userPromptTemplate).toContain('{{QUALITY_CHECKLIST}}');
    expect(template.userPromptTemplate).toContain('{{CUSTOM_INSTRUCTIONS}}');
    expect(template.userPromptTemplate).toContain('{{FILES_CONTEXT}}');
  });

  it('system prompt contains JSON schema', () => {
    const template = getPromptTemplate();
    expect(template.systemPrompt).toContain('JSON');
    expect(template.systemPrompt).toContain('summary');
    expect(template.systemPrompt).toContain('overallSeverity');
    expect(template.systemPrompt).toContain('comments');
    expect(template.systemPrompt).toContain('promptVersion');
  });
});

describe('getAvailablePromptVersions', () => {
  it('returns array of versions', () => {
    const versions = getAvailablePromptVersions();
    expect(Array.isArray(versions)).toBe(true);
    expect(versions).toContain('1.0.0');
  });
});

describe('getSecurityInstructions', () => {
  it('returns full checklist for security depth', () => {
    const instructions = getSecurityInstructions('security', []);
    expect(instructions).toContain('OWASP Top 10');
    expect(instructions).toContain('A01: Broken Access Control');
    expect(instructions).toContain('A03: Injection');
    expect(instructions).toContain('A10: Server-Side Request Forgery');
  });

  it('returns brief checklist when security is in focus', () => {
    const instructions = getSecurityInstructions('standard', ['security']);
    expect(instructions).toContain('Security Awareness');
    expect(instructions).toContain('Injection vulnerabilities');
    expect(instructions).not.toContain('A01: Broken Access Control');
  });

  it('returns brief checklist for standard depth', () => {
    const instructions = getSecurityInstructions('standard', []);
    expect(instructions).toContain('Security Awareness');
  });

  it('returns brief checklist for deep depth', () => {
    const instructions = getSecurityInstructions('deep', []);
    expect(instructions).toContain('Security Awareness');
  });

  it('returns empty for quick depth without security focus', () => {
    const instructions = getSecurityInstructions('quick', []);
    expect(instructions).toBe('');
  });

  it('returns brief for quick depth with security focus', () => {
    const instructions = getSecurityInstructions('quick', ['security']);
    expect(instructions).toContain('Security Awareness');
  });
});

describe('getQualityInstructions', () => {
  it('returns empty for quick depth', () => {
    const instructions = getQualityInstructions('quick', []);
    expect(instructions).toBe('');
  });

  it('returns brief checklist for standard depth', () => {
    const instructions = getQualityInstructions('standard', []);
    expect(instructions).toContain('Code Quality');
    expect(instructions).toContain('naming conventions');
    expect(instructions).not.toContain("DRY (Don't Repeat Yourself)");
  });

  it('returns full checklist for deep depth', () => {
    const instructions = getQualityInstructions('deep', []);
    expect(instructions).toContain('Code Quality Checklist');
    expect(instructions).toContain('Naming & Readability');
    expect(instructions).toContain("DRY (Don't Repeat Yourself)");
    expect(instructions).toContain('Type Safety');
  });

  it('returns full checklist when best-practices is in focus', () => {
    const instructions = getQualityInstructions('standard', ['best-practices']);
    expect(instructions).toContain('Code Quality Checklist');
    expect(instructions).toContain('Complexity');
  });
});

describe('getEffectiveDepth', () => {
  it('returns base depth when no path overrides', () => {
    const config = createMockConfig({
      review: { depth: 'standard', focus: [] },
    });
    expect(getEffectiveDepth('src/file.ts', config)).toBe('standard');
  });

  it('returns overridden depth for matching path', () => {
    const config = createMockConfig({
      review: { depth: 'standard', focus: [] },
      paths: [{ pattern: 'src/security/**', depth: 'security', ignore: false }],
    });
    expect(getEffectiveDepth('src/security/auth.ts', config)).toBe('security');
  });

  it('returns base depth for non-matching path', () => {
    const config = createMockConfig({
      review: { depth: 'standard', focus: [] },
      paths: [{ pattern: 'src/security/**', depth: 'security', ignore: false }],
    });
    expect(getEffectiveDepth('src/utils.ts', config)).toBe('standard');
  });

  it('uses first matching path override', () => {
    const config = createMockConfig({
      review: { depth: 'standard', focus: [] },
      paths: [
        { pattern: 'src/**', depth: 'deep', ignore: false },
        { pattern: 'src/security/**', depth: 'security', ignore: false },
      ],
    });
    expect(getEffectiveDepth('src/security/auth.ts', config)).toBe('deep');
  });
});

describe('getValidLineNumbers', () => {
  it('extracts line numbers from additions and context', () => {
    const hunks = [
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        content: '',
        lines: [
          {
            type: 'context' as const,
            content: 'ctx',
            oldLineNumber: 1,
            newLineNumber: 1,
          },
          { type: 'addition' as const, content: 'add', newLineNumber: 2 },
          { type: 'addition' as const, content: 'add2', newLineNumber: 3 },
          {
            type: 'context' as const,
            content: 'ctx2',
            oldLineNumber: 2,
            newLineNumber: 4,
          },
        ],
      },
    ];

    const lineNumbers = getValidLineNumbers(hunks);
    expect(lineNumbers).toEqual([1, 2, 3, 4]);
  });

  it('excludes deletions', () => {
    const hunks = [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 1,
        content: '',
        lines: [
          { type: 'deletion' as const, content: 'del', oldLineNumber: 1 },
          {
            type: 'context' as const,
            content: 'ctx',
            oldLineNumber: 2,
            newLineNumber: 1,
          },
        ],
      },
    ];

    const lineNumbers = getValidLineNumbers(hunks);
    expect(lineNumbers).toEqual([1]);
  });

  it('handles multiple hunks', () => {
    const hunks = [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        content: '',
        lines: [
          {
            type: 'context' as const,
            content: 'ctx',
            oldLineNumber: 1,
            newLineNumber: 1,
          },
          { type: 'addition' as const, content: 'add', newLineNumber: 2 },
        ],
      },
      {
        oldStart: 10,
        oldCount: 1,
        newStart: 11,
        newCount: 2,
        content: '',
        lines: [
          {
            type: 'context' as const,
            content: 'ctx',
            oldLineNumber: 10,
            newLineNumber: 11,
          },
          { type: 'addition' as const, content: 'add', newLineNumber: 12 },
        ],
      },
    ];

    const lineNumbers = getValidLineNumbers(hunks);
    expect(lineNumbers).toEqual([1, 2, 11, 12]);
  });

  it('removes duplicates and sorts', () => {
    const hunks = [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        content: '',
        lines: [
          {
            type: 'context' as const,
            content: 'ctx',
            oldLineNumber: 1,
            newLineNumber: 1,
          },
        ],
      },
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        content: '',
        lines: [
          {
            type: 'context' as const,
            content: 'ctx',
            oldLineNumber: 1,
            newLineNumber: 1,
          },
        ],
      },
    ];

    const lineNumbers = getValidLineNumbers(hunks);
    expect(lineNumbers).toEqual([1]); // No duplicates
  });

  it('returns empty array for empty hunks', () => {
    expect(getValidLineNumbers([])).toEqual([]);
  });
});

describe('buildReviewPrompt', () => {
  it('builds prompt with all placeholders replaced', () => {
    const config = createMockConfig();
    const files = [createMockFile()];

    const result = buildReviewPrompt({ config, files });

    expect(result.systemPrompt).toBeDefined();
    expect(result.userPrompt).toBeDefined();
    expect(result.promptVersion).toBe('1.0.0');

    // All placeholders should be replaced
    expect(result.userPrompt).not.toContain('{{DEPTH_INSTRUCTIONS}}');
    expect(result.userPrompt).not.toContain('{{SECURITY_INSTRUCTIONS}}');
    expect(result.userPrompt).not.toContain('{{QUALITY_CHECKLIST}}');
    expect(result.userPrompt).not.toContain('{{CUSTOM_INSTRUCTIONS}}');
    expect(result.userPrompt).not.toContain('{{FILES_CONTEXT}}');
  });

  it('includes depth instructions in prompt', () => {
    const config = createMockConfig({ review: { depth: 'deep', focus: [] } });
    const files = [createMockFile()];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('Thorough Analysis');
  });

  it('includes security instructions for security depth', () => {
    const config = createMockConfig({
      review: { depth: 'security', focus: [] },
    });
    const files = [createMockFile()];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('OWASP Top 10');
  });

  it('includes custom instructions from config', () => {
    const config = createMockConfig({
      review: {
        depth: 'standard',
        focus: [],
        instructions:
          'Always check for proper error handling in async functions.',
      },
    });
    const files = [createMockFile()];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('Project-Specific Instructions');
    expect(result.userPrompt).toContain(
      'Always check for proper error handling in async functions.'
    );
  });

  it('includes path-specific instructions', () => {
    const config = createMockConfig({
      review: { depth: 'standard', focus: [] },
      paths: [
        {
          pattern: 'src/**',
          instructions: 'This is the main source directory.',
          ignore: false,
        },
      ],
    });
    const files = [createMockFile({ filename: 'src/utils.ts' })];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('Path-Specific Instructions');
    expect(result.userPrompt).toContain('src/**');
    expect(result.userPrompt).toContain('This is the main source directory.');
  });

  it('includes file context with diff', () => {
    const config = createMockConfig();
    const files = [createMockFile({ filename: 'src/app.ts' })];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('### File: src/app.ts');
    expect(result.userPrompt).toContain('Status: modified');
    expect(result.userPrompt).toContain('```diff');
    expect(result.userPrompt).toContain('Valid line numbers for comments');
  });

  it('handles multiple files', () => {
    const config = createMockConfig();
    const files = [
      createMockFile({ filename: 'src/a.ts' }),
      createMockFile({ filename: 'src/b.ts' }),
    ];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('### File: src/a.ts');
    expect(result.userPrompt).toContain('### File: src/b.ts');
    expect(result.userPrompt).toContain('---'); // File separator
  });

  it('handles file with no hunks', () => {
    const config = createMockConfig();
    const files = [createMockFile({ filename: 'binary.png', hunks: [] })];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('binary or empty file');
  });

  it('uses specified prompt version', () => {
    const config = createMockConfig();
    const files = [createMockFile()];

    const result = buildReviewPrompt({ config, files, promptVersion: '1.0.0' });

    expect(result.promptVersion).toBe('1.0.0');
  });

  it('applies path-specific depth in file context', () => {
    const config = createMockConfig({
      review: { depth: 'standard', focus: [] },
      paths: [{ pattern: 'src/security/**', depth: 'security', ignore: false }],
    });
    const files = [createMockFile({ filename: 'src/security/auth.ts' })];

    const result = buildReviewPrompt({ config, files });

    expect(result.userPrompt).toContain('Review Depth: security');
  });
});

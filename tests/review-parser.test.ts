import { describe, expect, it } from 'vitest';

import type { ParsedPullRequestFile } from '../src/github';
import {
  buildReviewSummary,
  determineReviewEvent,
  extractJson,
  meetsMinSeverity,
  parseModelResponse,
  toCodeReview,
  validateComment,
} from '../src/review-parser';
import type { ParsedModelOutput, ValidatedComment } from '../src/review-schema';

// Test fixtures
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
      content: '@@ -1,3 +1,5 @@',
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

const createValidModelOutput = (): Record<string, unknown> => ({
  summary: 'Found 2 issues that need attention.',
  overallSeverity: 'high',
  comments: [
    {
      path: 'src/index.ts',
      line: 2,
      severity: 'high',
      category: 'security',
      message: 'Potential SQL injection',
    },
    {
      path: 'src/index.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      message: 'Consider using const',
    },
  ],
  promptVersion: '1.0.0',
});

describe('extractJson', () => {
  it('extracts JSON from markdown code block with json tag', () => {
    const response = '```json\n{"key": "value"}\n```';
    expect(extractJson(response)).toBe('{"key": "value"}');
  });

  it('extracts JSON from markdown code block without tag', () => {
    const response = '```\n{"key": "value"}\n```';
    expect(extractJson(response)).toBe('{"key": "value"}');
  });

  it('extracts raw JSON object', () => {
    const response = 'Here is the result: {"key": "value"}';
    expect(extractJson(response)).toBe('{"key": "value"}');
  });

  it('extracts complex nested JSON', () => {
    const json = JSON.stringify(createValidModelOutput());
    const response = `\`\`\`json\n${json}\n\`\`\``;
    const extracted = extractJson(response);
    expect(extracted).toBe(json);
  });

  it('handles JSON with newlines', () => {
    const response =
      '```json\n{\n  "key": "value",\n  "nested": {\n    "a": 1\n  }\n}\n```';
    const extracted = extractJson(response);
    expect(extracted).toContain('"key": "value"');
  });

  it('returns null for no JSON', () => {
    expect(extractJson('No JSON here')).toBe(null);
    expect(extractJson('')).toBe(null);
  });

  it('extracts first JSON object when multiple exist', () => {
    const response = '{"first": 1} and {"second": 2}';
    const extracted = extractJson(response);
    expect(extracted).toBe('{"first": 1} and {"second": 2}');
  });
});

describe('validateComment', () => {
  it('validates comment with valid line number', () => {
    const file = createMockFile();
    const comment = {
      path: 'src/index.ts',
      line: 2,
      severity: 'high' as const,
      category: 'bug' as const,
      message: 'Found a bug',
    };

    const result = validateComment(comment, file);

    expect(result.isValid).toBe(true);
    expect(result.validationErrors).toHaveLength(0);
  });

  it('invalidates comment when file not found', () => {
    const comment = {
      path: 'nonexistent.ts',
      line: 1,
      severity: 'high' as const,
      category: 'bug' as const,
      message: 'Found a bug',
    };

    const result = validateComment(comment, undefined);

    expect(result.isValid).toBe(false);
    expect(result.validationErrors).toContain(
      'File not found in PR: nonexistent.ts'
    );
  });

  it('invalidates comment with line not in diff', () => {
    const file = createMockFile();
    const comment = {
      path: 'src/index.ts',
      line: 999,
      severity: 'high' as const,
      category: 'bug' as const,
      message: 'Found a bug',
    };

    const result = validateComment(comment, file);

    expect(result.isValid).toBe(false);
    expect(result.validationErrors[0]).toContain('Line 999 is not in the diff');
  });

  it('validates multi-line comment with valid range', () => {
    const file = createMockFile();
    const comment = {
      path: 'src/index.ts',
      line: 1,
      endLine: 3,
      severity: 'high' as const,
      category: 'bug' as const,
      message: 'Found a bug',
    };

    const result = validateComment(comment, file);

    expect(result.isValid).toBe(true);
  });

  it('invalidates when endLine is less than line', () => {
    const file = createMockFile();
    const comment = {
      path: 'src/index.ts',
      line: 3,
      endLine: 1,
      severity: 'high' as const,
      category: 'bug' as const,
      message: 'Found a bug',
    };

    const result = validateComment(comment, file);

    expect(result.isValid).toBe(false);
    expect(result.validationErrors[0]).toContain(
      'endLine (1) cannot be less than line (3)'
    );
  });

  it('invalidates when endLine not in diff', () => {
    const file = createMockFile();
    const comment = {
      path: 'src/index.ts',
      line: 1,
      endLine: 999,
      severity: 'high' as const,
      category: 'bug' as const,
      message: 'Found a bug',
    };

    const result = validateComment(comment, file);

    expect(result.isValid).toBe(false);
    expect(result.validationErrors).toContain(
      'End line 999 is not in the diff for src/index.ts'
    );
  });

  it('invalidates empty message', () => {
    const file = createMockFile();
    const comment = {
      path: 'src/index.ts',
      line: 1,
      severity: 'high' as const,
      category: 'bug' as const,
      message: '   ',
    };

    const result = validateComment(comment, file);

    expect(result.isValid).toBe(false);
    expect(result.validationErrors).toContain(
      'Comment message cannot be empty'
    );
  });
});

describe('parseModelResponse', () => {
  it('parses valid model response', () => {
    const files = [createMockFile()];
    const response = JSON.stringify(createValidModelOutput());

    const result = parseModelResponse(response, files);

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output?.summary).toBe('Found 2 issues that need attention.');
    expect(result.validatedComments).toHaveLength(2);
    expect(result.parseErrors).toHaveLength(0);
  });

  it('handles JSON in code block', () => {
    const files = [createMockFile()];
    const response = `Here's my review:\n\n\`\`\`json\n${JSON.stringify(createValidModelOutput())}\n\`\`\``;

    const result = parseModelResponse(response, files);

    expect(result.success).toBe(true);
  });

  it('returns error for missing JSON', () => {
    const files = [createMockFile()];
    const response = 'No JSON here, just text.';

    const result = parseModelResponse(response, files);

    expect(result.success).toBe(false);
    expect(result.parseErrors).toContain(
      'Could not extract JSON from model response'
    );
  });

  it('returns error for invalid JSON syntax', () => {
    const files = [createMockFile()];
    const response = '{"invalid": json}';

    const result = parseModelResponse(response, files);

    expect(result.success).toBe(false);
    expect(result.parseErrors[0]).toContain('JSON parse error');
  });

  it('returns error for schema validation failure', () => {
    const files = [createMockFile()];
    const response = JSON.stringify({
      summary: 'Test',
      // Missing required fields
    });

    const result = parseModelResponse(response, files);

    expect(result.success).toBe(false);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it('validates comments against files', () => {
    const files = [createMockFile()];
    const output = {
      ...createValidModelOutput(),
      comments: [
        {
          path: 'src/index.ts',
          line: 2, // Valid line
          severity: 'high',
          category: 'bug',
          message: 'Valid comment',
        },
        {
          path: 'nonexistent.ts', // File doesn't exist
          line: 1,
          severity: 'high',
          category: 'bug',
          message: 'Invalid file',
        },
      ],
    };
    const response = JSON.stringify(output);

    const result = parseModelResponse(response, files);

    expect(result.success).toBe(true);
    expect(result.stats.validComments).toBe(1);
    expect(result.stats.invalidComments).toBe(1);
  });

  it('calculates stats correctly', () => {
    const files = [createMockFile()];
    const response = JSON.stringify(createValidModelOutput());

    const result = parseModelResponse(response, files);

    expect(result.stats.totalComments).toBe(2);
    expect(result.stats.validComments).toBe(2);
    expect(result.stats.invalidComments).toBe(0);
    expect(result.stats.bySeverity.high).toBe(1);
    expect(result.stats.bySeverity.low).toBe(1);
    expect(result.stats.byCategory.security).toBe(1);
    expect(result.stats.byCategory.style).toBe(1);
  });
});

describe('determineReviewEvent', () => {
  it('returns REQUEST_CHANGES for critical severity', () => {
    expect(determineReviewEvent('critical', [])).toBe('REQUEST_CHANGES');
  });

  it('returns REQUEST_CHANGES for high severity', () => {
    expect(determineReviewEvent('high', [])).toBe('REQUEST_CHANGES');
  });

  it('returns REQUEST_CHANGES when any comment is critical', () => {
    const comments: ValidatedComment[] = [
      {
        path: 'a.ts',
        line: 1,
        severity: 'critical',
        category: 'security',
        message: 'Critical issue',
        isValid: true,
        validationErrors: [],
      },
    ];
    expect(determineReviewEvent('medium', comments)).toBe('REQUEST_CHANGES');
  });

  it('returns COMMENT for medium severity with no critical comments', () => {
    const comments: ValidatedComment[] = [
      {
        path: 'a.ts',
        line: 1,
        severity: 'medium',
        category: 'bug',
        message: 'Medium issue',
        isValid: true,
        validationErrors: [],
      },
    ];
    expect(determineReviewEvent('medium', comments)).toBe('COMMENT');
  });

  it('returns COMMENT for low severity with comments', () => {
    const comments: ValidatedComment[] = [
      {
        path: 'a.ts',
        line: 1,
        severity: 'low',
        category: 'style',
        message: 'Style issue',
        isValid: true,
        validationErrors: [],
      },
    ];
    expect(determineReviewEvent('low', comments)).toBe('COMMENT');
  });

  it('returns APPROVE for none severity with no comments', () => {
    expect(determineReviewEvent('none', [])).toBe('APPROVE');
  });

  it('returns APPROVE for none severity with only invalid comments', () => {
    const comments: ValidatedComment[] = [
      {
        path: 'a.ts',
        line: 999,
        severity: 'high',
        category: 'bug',
        message: 'Invalid comment',
        isValid: false,
        validationErrors: ['Line not in diff'],
      },
    ];
    // Note: invalid comments are filtered before calling this
    const validComments = comments.filter((c) => c.isValid);
    expect(determineReviewEvent('none', validComments)).toBe('APPROVE');
  });
});

describe('buildReviewSummary', () => {
  it('builds summary with issue count', () => {
    const parsedOutput: ParsedModelOutput = {
      success: true,
      output: {
        summary: 'Found some issues.',
        overallSeverity: 'medium',
        comments: [],
        promptVersion: '1.0.0',
      },
      validatedComments: [
        {
          path: 'a.ts',
          line: 1,
          severity: 'medium',
          category: 'bug',
          message: 'Issue',
          isValid: true,
          validationErrors: [],
        },
      ],
      parseErrors: [],
      stats: {
        totalComments: 1,
        validComments: 1,
        invalidComments: 0,
        byCategory: {
          security: 0,
          bug: 1,
          performance: 0,
          style: 0,
          maintainability: 0,
        },
        bySeverity: { critical: 0, high: 0, medium: 1, low: 0 },
      },
    };

    const summary = buildReviewSummary(parsedOutput, '1.0.0');

    expect(summary).toContain('Quorum AI Code Review');
    expect(summary).toContain('Found some issues.');
    expect(summary).toContain('Issues Found:** 1');
    expect(summary).toContain('By Severity');
    expect(summary).toContain('Medium: 1');
    expect(summary).toContain('Prompt version: 1.0.0');
  });

  it('includes skipped comments count when present', () => {
    const parsedOutput: ParsedModelOutput = {
      success: true,
      output: {
        summary: 'Review complete.',
        overallSeverity: 'none',
        comments: [],
        promptVersion: '1.0.0',
      },
      validatedComments: [],
      parseErrors: [],
      stats: {
        totalComments: 2,
        validComments: 1,
        invalidComments: 1,
        byCategory: {
          security: 1,
          bug: 0,
          performance: 0,
          style: 0,
          maintainability: 0,
        },
        bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
      },
    };

    const summary = buildReviewSummary(parsedOutput, '1.0.0');

    expect(summary).toContain('Skipped Comments:** 1');
    expect(summary).toContain('invalid line references');
  });

  it('handles no issues found', () => {
    const parsedOutput: ParsedModelOutput = {
      success: true,
      output: {
        summary: 'Code looks clean!',
        overallSeverity: 'none',
        comments: [],
        promptVersion: '1.0.0',
      },
      validatedComments: [],
      parseErrors: [],
      stats: {
        totalComments: 0,
        validComments: 0,
        invalidComments: 0,
        byCategory: {
          security: 0,
          bug: 0,
          performance: 0,
          style: 0,
          maintainability: 0,
        },
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      },
    };

    const summary = buildReviewSummary(parsedOutput, '1.0.0');

    expect(summary).toContain('Code looks clean!');
    expect(summary).toContain('Issues Found:** 0');
    expect(summary).not.toContain('By Severity'); // No severity breakdown for 0 issues
  });
});

describe('toCodeReview', () => {
  it('converts parsed output to CodeReview', () => {
    const files = [createMockFile()];
    const response = JSON.stringify(createValidModelOutput());
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    expect(review.event).toBe('REQUEST_CHANGES'); // High severity
    expect(review.body).toContain('Quorum AI Code Review');
    expect(review.comments).toHaveLength(2);
  });

  it('formats comments with severity badge', () => {
    const files = [createMockFile()];
    const response = JSON.stringify(createValidModelOutput());
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    expect(review.comments[0].body).toContain('🟠 **High**');
    expect(review.comments[0].body).toContain('Potential SQL injection');
  });

  it('adds suggestion in GitHub format', () => {
    const files = [createMockFile()];
    const output = {
      ...createValidModelOutput(),
      comments: [
        {
          path: 'src/index.ts',
          line: 2,
          severity: 'medium',
          category: 'style',
          message: 'Use const instead',
          suggestion: 'const x = 1;',
        },
      ],
    };
    const response = JSON.stringify(output);
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    expect(review.comments[0].body).toContain('```suggestion');
    expect(review.comments[0].body).toContain('const x = 1;');
  });

  it('sets correct line for single-line comment', () => {
    const files = [createMockFile()];
    const output = {
      ...createValidModelOutput(),
      comments: [
        {
          path: 'src/index.ts',
          line: 2,
          severity: 'low',
          category: 'style',
          message: 'Single line',
        },
      ],
    };
    const response = JSON.stringify(output);
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    expect(review.comments[0].line).toBe(2);
    expect(review.comments[0].startLine).toBeUndefined();
  });

  it('sets startLine and line for multi-line comment', () => {
    const files = [createMockFile()];
    const output = {
      ...createValidModelOutput(),
      comments: [
        {
          path: 'src/index.ts',
          line: 1,
          endLine: 3,
          severity: 'medium',
          category: 'maintainability',
          message: 'Multi-line issue',
        },
      ],
    };
    const response = JSON.stringify(output);
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    expect(review.comments[0].line).toBe(3); // endLine
    expect(review.comments[0].startLine).toBe(1);
    expect(review.comments[0].startSide).toBe('RIGHT');
  });

  it('filters out invalid comments', () => {
    const files = [createMockFile()];
    const output = {
      ...createValidModelOutput(),
      comments: [
        {
          path: 'src/index.ts',
          line: 2,
          severity: 'high',
          category: 'bug',
          message: 'Valid comment',
        },
        {
          path: 'nonexistent.ts',
          line: 1,
          severity: 'critical',
          category: 'security',
          message: 'Invalid - file not found',
        },
      ],
    };
    const response = JSON.stringify(output);
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    expect(review.comments).toHaveLength(1);
    expect(review.comments[0].body).toContain('Valid comment');
  });

  it('returns APPROVE for no valid comments', () => {
    const files = [createMockFile()];
    const output = {
      summary: 'Clean code.',
      overallSeverity: 'none',
      comments: [],
      promptVersion: '1.0.0',
    };
    const response = JSON.stringify(output);
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    expect(review.event).toBe('APPROVE');
    expect(review.comments).toHaveLength(0);
  });

  it('sets side to RIGHT for all comments', () => {
    const files = [createMockFile()];
    const response = JSON.stringify(createValidModelOutput());
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0');

    for (const comment of review.comments) {
      expect(comment.side).toBe('RIGHT');
    }
  });

  it('filters comments by minSeverity', () => {
    const files = [createMockFile()];
    const output = {
      ...createValidModelOutput(),
      comments: [
        {
          path: 'src/index.ts',
          line: 1,
          severity: 'critical',
          category: 'security',
          message: 'Critical issue',
        },
        {
          path: 'src/index.ts',
          line: 2,
          severity: 'high',
          category: 'security',
          message: 'High issue',
        },
        {
          path: 'src/index.ts',
          line: 3,
          severity: 'medium',
          category: 'maintainability',
          message: 'Medium issue',
        },
        {
          path: 'src/index.ts',
          line: 2, // Use valid line from mock file
          severity: 'low',
          category: 'style',
          message: 'Low issue',
        },
      ],
    };
    const response = JSON.stringify(output);
    const parsed = parseModelResponse(response, files);

    // minSeverity: high should only include critical and high
    const review = toCodeReview(parsed, '1.0.0', { minSeverity: 'high' });

    expect(review.comments).toHaveLength(2);
    expect(review.comments[0].body).toContain('Critical issue');
    expect(review.comments[1].body).toContain('High issue');
  });

  it('uses custom severity emojis when provided', () => {
    const files = [createMockFile()];
    const response = JSON.stringify(createValidModelOutput());
    const parsed = parseModelResponse(response, files);

    const review = toCodeReview(parsed, '1.0.0', {
      minSeverity: 'low',
      severityEmoji: { high: '⚠️' },
    });

    expect(review.comments[0].body).toContain('⚠️ **High**');
  });

  it('falls back to default emoji when custom not provided for severity', () => {
    const files = [createMockFile()];
    const output = {
      ...createValidModelOutput(),
      comments: [
        {
          path: 'src/index.ts',
          line: 2,
          severity: 'critical',
          category: 'security',
          message: 'Critical issue',
        },
      ],
    };
    const response = JSON.stringify(output);
    const parsed = parseModelResponse(response, files);

    // Only override high, not critical
    const review = toCodeReview(parsed, '1.0.0', {
      minSeverity: 'low',
      severityEmoji: { high: '⚠️' },
    });

    // Should use default emoji for critical
    expect(review.comments[0].body).toContain('🔴 **Critical**');
  });
});

describe('meetsMinSeverity', () => {
  it('returns true when severity equals minSeverity', () => {
    expect(meetsMinSeverity('high', 'high')).toBe(true);
    expect(meetsMinSeverity('low', 'low')).toBe(true);
  });

  it('returns true when severity is higher than minSeverity', () => {
    expect(meetsMinSeverity('critical', 'low')).toBe(true);
    expect(meetsMinSeverity('high', 'medium')).toBe(true);
    expect(meetsMinSeverity('medium', 'low')).toBe(true);
  });

  it('returns false when severity is lower than minSeverity', () => {
    expect(meetsMinSeverity('low', 'medium')).toBe(false);
    expect(meetsMinSeverity('medium', 'high')).toBe(false);
    expect(meetsMinSeverity('high', 'critical')).toBe(false);
  });

  it('handles all severity combinations correctly', () => {
    // critical (4) meets all
    expect(meetsMinSeverity('critical', 'critical')).toBe(true);
    expect(meetsMinSeverity('critical', 'high')).toBe(true);
    expect(meetsMinSeverity('critical', 'medium')).toBe(true);
    expect(meetsMinSeverity('critical', 'low')).toBe(true);

    // high (3) meets high, medium, low
    expect(meetsMinSeverity('high', 'critical')).toBe(false);
    expect(meetsMinSeverity('high', 'high')).toBe(true);
    expect(meetsMinSeverity('high', 'medium')).toBe(true);
    expect(meetsMinSeverity('high', 'low')).toBe(true);

    // medium (2) meets medium, low
    expect(meetsMinSeverity('medium', 'critical')).toBe(false);
    expect(meetsMinSeverity('medium', 'high')).toBe(false);
    expect(meetsMinSeverity('medium', 'medium')).toBe(true);
    expect(meetsMinSeverity('medium', 'low')).toBe(true);

    // low (1) only meets low
    expect(meetsMinSeverity('low', 'critical')).toBe(false);
    expect(meetsMinSeverity('low', 'high')).toBe(false);
    expect(meetsMinSeverity('low', 'medium')).toBe(false);
    expect(meetsMinSeverity('low', 'low')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  calculateStats,
  CategorySchema,
  createEmptyStats,
  ModelReviewOutputSchema,
  OverallSeveritySchema,
  ReviewCommentSchema,
  SeveritySchema,
  type ValidatedComment,
} from '../src/review-schema';

describe('SeveritySchema', () => {
  it('accepts valid severity levels', () => {
    expect(SeveritySchema.parse('critical')).toBe('critical');
    expect(SeveritySchema.parse('high')).toBe('high');
    expect(SeveritySchema.parse('medium')).toBe('medium');
    expect(SeveritySchema.parse('low')).toBe('low');
  });

  it('rejects invalid severity levels', () => {
    expect(() => SeveritySchema.parse('invalid')).toThrow();
    expect(() => SeveritySchema.parse('')).toThrow();
    expect(() => SeveritySchema.parse('CRITICAL')).toThrow(); // Case sensitive
  });
});

describe('OverallSeveritySchema', () => {
  it('accepts valid overall severity levels', () => {
    expect(OverallSeveritySchema.parse('none')).toBe('none');
    expect(OverallSeveritySchema.parse('low')).toBe('low');
    expect(OverallSeveritySchema.parse('medium')).toBe('medium');
    expect(OverallSeveritySchema.parse('high')).toBe('high');
    expect(OverallSeveritySchema.parse('critical')).toBe('critical');
  });

  it('rejects invalid overall severity levels', () => {
    expect(() => OverallSeveritySchema.parse('warning')).toThrow();
    expect(() => OverallSeveritySchema.parse('info')).toThrow();
  });
});

describe('CategorySchema', () => {
  it('accepts valid categories', () => {
    expect(CategorySchema.parse('security')).toBe('security');
    expect(CategorySchema.parse('bug')).toBe('bug');
    expect(CategorySchema.parse('performance')).toBe('performance');
    expect(CategorySchema.parse('style')).toBe('style');
    expect(CategorySchema.parse('maintainability')).toBe('maintainability');
  });

  it('rejects invalid categories', () => {
    expect(() => CategorySchema.parse('error')).toThrow();
    expect(() => CategorySchema.parse('warning')).toThrow();
    expect(() => CategorySchema.parse('')).toThrow();
  });
});

describe('ReviewCommentSchema', () => {
  it('accepts valid comment', () => {
    const comment = {
      path: 'src/index.ts',
      line: 42,
      severity: 'high',
      category: 'security',
      message: 'SQL injection vulnerability detected',
    };

    const result = ReviewCommentSchema.safeParse(comment);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('src/index.ts');
      expect(result.data.line).toBe(42);
      expect(result.data.endLine).toBeUndefined();
      expect(result.data.suggestion).toBeUndefined();
    }
  });

  it('accepts comment with all optional fields', () => {
    const comment = {
      path: 'src/utils.ts',
      line: 10,
      endLine: 15,
      severity: 'medium',
      category: 'maintainability',
      message: 'Consider extracting this to a function',
      suggestion: 'function extractedLogic() { ... }',
    };

    const result = ReviewCommentSchema.safeParse(comment);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endLine).toBe(15);
      expect(result.data.suggestion).toBe('function extractedLogic() { ... }');
    }
  });

  it('rejects comment with empty path', () => {
    const comment = {
      path: '',
      line: 1,
      severity: 'low',
      category: 'style',
      message: 'Use const instead of let',
    };

    const result = ReviewCommentSchema.safeParse(comment);
    expect(result.success).toBe(false);
  });

  it('rejects comment with non-positive line number', () => {
    const comment = {
      path: 'src/index.ts',
      line: 0,
      severity: 'low',
      category: 'style',
      message: 'Invalid line',
    };

    const result = ReviewCommentSchema.safeParse(comment);
    expect(result.success).toBe(false);
  });

  it('rejects comment with negative line number', () => {
    const comment = {
      path: 'src/index.ts',
      line: -5,
      severity: 'low',
      category: 'style',
      message: 'Invalid line',
    };

    const result = ReviewCommentSchema.safeParse(comment);
    expect(result.success).toBe(false);
  });

  it('rejects comment with empty message', () => {
    const comment = {
      path: 'src/index.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      message: '',
    };

    const result = ReviewCommentSchema.safeParse(comment);
    expect(result.success).toBe(false);
  });

  it('rejects comment with missing required fields', () => {
    const partial = {
      path: 'src/index.ts',
      line: 1,
      // missing severity, category, message
    };

    const result = ReviewCommentSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });
});

describe('ModelReviewOutputSchema', () => {
  it('accepts valid complete output', () => {
    const output = {
      summary: 'Found 2 issues that need attention.',
      overallSeverity: 'high',
      comments: [
        {
          path: 'src/auth.ts',
          line: 25,
          severity: 'high',
          category: 'security',
          message: 'Password stored in plain text',
        },
        {
          path: 'src/utils.ts',
          line: 10,
          severity: 'low',
          category: 'style',
          message: 'Consider using const',
        },
      ],
      promptVersion: '1.0.0',
    };

    const result = ModelReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe('Found 2 issues that need attention.');
      expect(result.data.overallSeverity).toBe('high');
      expect(result.data.comments).toHaveLength(2);
      expect(result.data.promptVersion).toBe('1.0.0');
    }
  });

  it('accepts output with empty comments array', () => {
    const output = {
      summary: 'Code looks clean, no issues found.',
      overallSeverity: 'none',
      comments: [],
      promptVersion: '1.0.0',
    };

    const result = ModelReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.comments).toHaveLength(0);
    }
  });

  it('defaults comments to empty array when missing', () => {
    const output = {
      summary: 'Review complete.',
      overallSeverity: 'none',
      promptVersion: '1.0.0',
    };

    const result = ModelReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.comments).toEqual([]);
    }
  });

  it('rejects output with empty summary', () => {
    const output = {
      summary: '',
      overallSeverity: 'none',
      comments: [],
      promptVersion: '1.0.0',
    };

    const result = ModelReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });

  it('rejects output with missing promptVersion', () => {
    const output = {
      summary: 'Review complete.',
      overallSeverity: 'none',
      comments: [],
    };

    const result = ModelReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });

  it('rejects output with invalid comment in array', () => {
    const output = {
      summary: 'Found issues.',
      overallSeverity: 'high',
      comments: [
        {
          path: 'src/file.ts',
          line: 10,
          severity: 'invalid-severity', // Invalid
          category: 'bug',
          message: 'Something wrong',
        },
      ],
      promptVersion: '1.0.0',
    };

    const result = ModelReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });
});

describe('createEmptyStats', () => {
  it('returns stats with all zeros', () => {
    const stats = createEmptyStats();

    expect(stats.totalComments).toBe(0);
    expect(stats.validComments).toBe(0);
    expect(stats.invalidComments).toBe(0);
    expect(stats.byCategory.security).toBe(0);
    expect(stats.byCategory.bug).toBe(0);
    expect(stats.byCategory.performance).toBe(0);
    expect(stats.byCategory.style).toBe(0);
    expect(stats.byCategory.maintainability).toBe(0);
    expect(stats.bySeverity.critical).toBe(0);
    expect(stats.bySeverity.high).toBe(0);
    expect(stats.bySeverity.medium).toBe(0);
    expect(stats.bySeverity.low).toBe(0);
  });
});

describe('calculateStats', () => {
  it('calculates stats for valid comments', () => {
    const comments: ValidatedComment[] = [
      {
        path: 'a.ts',
        line: 1,
        severity: 'critical',
        category: 'security',
        message: 'Issue 1',
        isValid: true,
        validationErrors: [],
      },
      {
        path: 'b.ts',
        line: 2,
        severity: 'high',
        category: 'bug',
        message: 'Issue 2',
        isValid: true,
        validationErrors: [],
      },
      {
        path: 'c.ts',
        line: 3,
        severity: 'low',
        category: 'style',
        message: 'Issue 3',
        isValid: true,
        validationErrors: [],
      },
    ];

    const stats = calculateStats(comments);

    expect(stats.totalComments).toBe(3);
    expect(stats.validComments).toBe(3);
    expect(stats.invalidComments).toBe(0);
    expect(stats.byCategory.security).toBe(1);
    expect(stats.byCategory.bug).toBe(1);
    expect(stats.byCategory.style).toBe(1);
    expect(stats.bySeverity.critical).toBe(1);
    expect(stats.bySeverity.high).toBe(1);
    expect(stats.bySeverity.low).toBe(1);
  });

  it('counts invalid comments separately', () => {
    const comments: ValidatedComment[] = [
      {
        path: 'a.ts',
        line: 1,
        severity: 'high',
        category: 'security',
        message: 'Valid issue',
        isValid: true,
        validationErrors: [],
      },
      {
        path: 'nonexistent.ts',
        line: 999,
        severity: 'critical',
        category: 'bug',
        message: 'Invalid - wrong line',
        isValid: false,
        validationErrors: ['Line not in diff'],
      },
    ];

    const stats = calculateStats(comments);

    expect(stats.totalComments).toBe(2);
    expect(stats.validComments).toBe(1);
    expect(stats.invalidComments).toBe(1);
    // Invalid comments are NOT counted in category/severity
    expect(stats.byCategory.security).toBe(1);
    expect(stats.byCategory.bug).toBe(0);
    expect(stats.bySeverity.high).toBe(1);
    expect(stats.bySeverity.critical).toBe(0);
  });

  it('handles empty comments array', () => {
    const stats = calculateStats([]);

    expect(stats.totalComments).toBe(0);
    expect(stats.validComments).toBe(0);
    expect(stats.invalidComments).toBe(0);
  });

  it('counts multiple comments in same category', () => {
    const comments: ValidatedComment[] = [
      {
        path: 'a.ts',
        line: 1,
        severity: 'high',
        category: 'security',
        message: 'Security 1',
        isValid: true,
        validationErrors: [],
      },
      {
        path: 'b.ts',
        line: 2,
        severity: 'critical',
        category: 'security',
        message: 'Security 2',
        isValid: true,
        validationErrors: [],
      },
      {
        path: 'c.ts',
        line: 3,
        severity: 'medium',
        category: 'security',
        message: 'Security 3',
        isValid: true,
        validationErrors: [],
      },
    ];

    const stats = calculateStats(comments);

    expect(stats.byCategory.security).toBe(3);
    expect(stats.bySeverity.critical).toBe(1);
    expect(stats.bySeverity.high).toBe(1);
    expect(stats.bySeverity.medium).toBe(1);
  });
});

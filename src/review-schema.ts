/**
 * Zod schemas for validating AI model review output
 *
 * Defines the structure expected from the LLM response,
 * including severity levels, categories, and comment format.
 */

import { z } from 'zod';

// ============================================================================
// Severity and Category Enums
// ============================================================================

/**
 * Severity levels for individual review comments
 */
export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Overall severity for the entire review
 * Includes 'none' for clean code with no issues
 */
export const OverallSeveritySchema = z.enum([
  'none',
  'low',
  'medium',
  'high',
  'critical',
]);
export type OverallSeverity = z.infer<typeof OverallSeveritySchema>;

/**
 * Categories of issues found during review
 */
export const CategorySchema = z.enum([
  'security',
  'bug',
  'performance',
  'style',
  'maintainability',
]);
export type Category = z.infer<typeof CategorySchema>;

// ============================================================================
// Review Comment Schema
// ============================================================================

/**
 * Schema for a single review comment from the model
 *
 * Maps to GitHub's review comment structure:
 * - path: File path relative to repo root
 * - line: Line number in the new file (RIGHT side of diff)
 * - endLine: Optional end line for multi-line comments
 * - severity: How critical the issue is
 * - category: Type of issue (security, bug, etc.)
 * - message: Human-readable explanation
 * - suggestion: Optional code fix
 */
export const ReviewCommentSchema = z.object({
  path: z.string().min(1).describe('File path relative to repository root'),
  line: z
    .number()
    .int()
    .positive()
    .describe('Line number in new file (RIGHT side of diff)'),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('End line for multi-line comments'),
  severity: SeveritySchema.describe('Severity of the issue'),
  category: CategorySchema.describe('Category of the issue'),
  message: z.string().min(1).describe('Explanation of the issue'),
  suggestion: z.string().nullish().describe('Suggested code fix'),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

// ============================================================================
// Model Output Schema
// ============================================================================

/**
 * Complete output schema expected from the model
 *
 * The model must return JSON matching this structure exactly.
 * promptVersion is included for A/B testing tracking.
 */
export const ModelReviewOutputSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe('Brief overall assessment (2-3 sentences)'),
  overallSeverity: OverallSeveritySchema.describe(
    'Highest severity level found'
  ),
  comments: z
    .array(ReviewCommentSchema)
    .default([])
    .describe('Review comments'),
  promptVersion: z.string().describe('Version of prompt template used'),
});
export type ModelReviewOutput = z.infer<typeof ModelReviewOutputSchema>;

// ============================================================================
// Validated Comment Types
// ============================================================================

/**
 * A comment that has been validated against the diff
 */
export interface ValidatedComment extends ReviewComment {
  isValid: boolean;
  validationErrors: string[];
}

/**
 * Statistics about parsed comments
 */
export interface CommentStats {
  totalComments: number;
  validComments: number;
  invalidComments: number;
  byCategory: Record<Category, number>;
  bySeverity: Record<Severity, number>;
}

/**
 * Result of parsing and validating model output
 */
export interface ParsedModelOutput {
  success: boolean;
  output?: ModelReviewOutput;
  validatedComments: ValidatedComment[];
  parseErrors: string[];
  stats: CommentStats;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates empty statistics object
 */
export function createEmptyStats(): CommentStats {
  return {
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
    bySeverity: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
  };
}

/**
 * Calculates statistics from validated comments
 */
export function calculateStats(comments: ValidatedComment[]): CommentStats {
  const stats = createEmptyStats();

  stats.totalComments = comments.length;

  for (const comment of comments) {
    if (comment.isValid) {
      stats.validComments++;
      stats.byCategory[comment.category]++;
      stats.bySeverity[comment.severity]++;
    } else {
      stats.invalidComments++;
    }
  }

  return stats;
}

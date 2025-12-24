/**
 * Response parser for AI model review output
 *
 * Parses model JSON responses, validates comments against diffs,
 * and converts to GitHub CodeReview format.
 */

import { isLineInDiff } from './diff-parser.js';
import {
  formatSuggestionWithMessage,
  type CodeReview,
  type MultiLineReviewComment,
  type ParsedPullRequestFile,
} from './github.js';
import {
  calculateStats,
  createEmptyStats,
  ModelReviewOutputSchema,
  type OverallSeverity,
  type ParsedModelOutput,
  type ReviewComment,
  type ValidatedComment,
} from './review-schema.js';

// ============================================================================
// JSON Extraction
// ============================================================================

/**
 * Extracts JSON from model response
 * Handles responses wrapped in markdown code blocks
 */
export function extractJson(response: string): string | null {
  // Try to find JSON in code block first (```json or ```)
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(response);
  if (codeBlockMatch?.[1] !== undefined) {
    return codeBlockMatch[1].trim();
  }

  // Try to find raw JSON object
  const jsonMatch = /\{[\s\S]*\}/.exec(response);
  if (jsonMatch !== null) {
    return jsonMatch[0];
  }

  return null;
}

// ============================================================================
// Comment Validation
// ============================================================================

/**
 * Validates a review comment against the file diff
 */
export function validateComment(
  comment: ReviewComment,
  file: ParsedPullRequestFile | undefined
): ValidatedComment {
  const errors: string[] = [];

  // Check file exists
  if (file === undefined) {
    errors.push(`File not found in PR: ${comment.path}`);
    return { ...comment, isValid: false, validationErrors: errors };
  }

  // Check line is in diff (RIGHT side for new file)
  if (!isLineInDiff(file.hunks, comment.line, 'RIGHT')) {
    errors.push(
      `Line ${String(comment.line)} is not in the diff for ${comment.path}`
    );
  }

  // Check endLine if present
  if (comment.endLine !== undefined) {
    if (comment.endLine < comment.line) {
      errors.push(
        `endLine (${String(comment.endLine)}) cannot be less than line (${String(comment.line)})`
      );
    }
    if (!isLineInDiff(file.hunks, comment.endLine, 'RIGHT')) {
      errors.push(
        `End line ${String(comment.endLine)} is not in the diff for ${comment.path}`
      );
    }
  }

  // Validate message is not empty after trimming
  if (comment.message.trim().length === 0) {
    errors.push('Comment message cannot be empty');
  }

  return {
    ...comment,
    isValid: errors.length === 0,
    validationErrors: errors,
  };
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parses raw model response string into validated output
 */
export function parseModelResponse(
  rawResponse: string,
  files: ParsedPullRequestFile[]
): ParsedModelOutput {
  // Extract JSON from response
  const jsonString = extractJson(rawResponse);
  if (jsonString === null) {
    return {
      success: false,
      parseErrors: ['Could not extract JSON from model response'],
      validatedComments: [],
      stats: createEmptyStats(),
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    return {
      success: false,
      parseErrors: [
        `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
      ],
      validatedComments: [],
      stats: createEmptyStats(),
    };
  }

  // Validate against schema
  const result = ModelReviewOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      parseErrors: result.error.errors.map(
        (e) => `${e.path.join('.')}: ${e.message}`
      ),
      validatedComments: [],
      stats: createEmptyStats(),
    };
  }

  const output = result.data;

  // Build file lookup map for validation
  const fileMap = new Map(files.map((f) => [f.filename, f]));

  // Validate each comment against diff
  const validatedComments: ValidatedComment[] = output.comments.map(
    (comment) => {
      const file = fileMap.get(comment.path);
      return validateComment(comment, file);
    }
  );

  // Calculate stats
  const stats = calculateStats(validatedComments);

  return {
    success: true,
    output,
    validatedComments,
    parseErrors: [],
    stats,
  };
}

// ============================================================================
// CodeReview Conversion
// ============================================================================

/**
 * Determines GitHub review event based on findings
 */
export function determineReviewEvent(
  overallSeverity: OverallSeverity,
  validComments: ValidatedComment[]
): CodeReview['event'] {
  // REQUEST_CHANGES for critical/high severity
  if (overallSeverity === 'critical' || overallSeverity === 'high') {
    return 'REQUEST_CHANGES';
  }

  // Check for any critical comments
  const hasCritical = validComments.some((c) => c.severity === 'critical');
  if (hasCritical) {
    return 'REQUEST_CHANGES';
  }

  // COMMENT for medium/low findings
  if (validComments.length > 0) {
    return 'COMMENT';
  }

  // APPROVE if no issues
  return 'APPROVE';
}

/**
 * Builds review summary with metadata
 */
export function buildReviewSummary(
  parsedOutput: ParsedModelOutput,
  promptVersion: string
): string {
  const { output, stats } = parsedOutput;

  const lines: string[] = [
    '## Quorum AI Code Review',
    '',
    output?.summary ?? 'Review completed.',
    '',
    '### Summary',
    `- **Issues Found:** ${String(stats.validComments)}`,
  ];

  if (stats.validComments > 0) {
    lines.push(
      `- **By Severity:** Critical: ${String(stats.bySeverity.critical)}, High: ${String(stats.bySeverity.high)}, Medium: ${String(stats.bySeverity.medium)}, Low: ${String(stats.bySeverity.low)}`
    );
  }

  if (stats.invalidComments > 0) {
    lines.push(
      `- **Skipped Comments:** ${String(stats.invalidComments)} (invalid line references)`
    );
  }

  lines.push('', '---', `_Prompt version: ${promptVersion}_`);

  return lines.join('\n');
}

/**
 * Formats a comment severity for display
 */
function formatSeverityBadge(severity: ReviewComment['severity']): string {
  return `**[${severity.toUpperCase()}]**`;
}

/**
 * Converts parsed model output to GitHub CodeReview format
 */
export function toCodeReview(
  parsedOutput: ParsedModelOutput,
  promptVersion: string
): CodeReview {
  // Filter to only valid comments
  const validComments = parsedOutput.validatedComments.filter((c) => c.isValid);

  // Determine review event based on severity
  const event = determineReviewEvent(
    parsedOutput.output?.overallSeverity ?? 'none',
    validComments
  );

  // Build summary with metadata
  const summary = buildReviewSummary(parsedOutput, promptVersion);

  // Convert to GitHub comment format
  const comments: MultiLineReviewComment[] = validComments.map((comment) => {
    let body = `${formatSeverityBadge(comment.severity)} ${comment.message}`;

    // Add suggestion in GitHub format if present
    if (comment.suggestion !== undefined && comment.suggestion !== null) {
      body = formatSuggestionWithMessage(body, comment.suggestion);
    }

    const ghComment: MultiLineReviewComment = {
      path: comment.path,
      line: comment.endLine ?? comment.line,
      body,
      side: 'RIGHT',
    };

    // Add multi-line support
    if (comment.endLine !== undefined && comment.endLine !== comment.line) {
      ghComment.startLine = comment.line;
      ghComment.startSide = 'RIGHT';
    }

    return ghComment;
  });

  return {
    body: summary,
    event,
    comments,
  };
}

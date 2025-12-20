/**
 * GitHub API integration for fetching PR diffs and posting review comments
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import type { GitHub } from '@actions/github/lib/utils';

import { withRetry } from './retry.js';

// ============================================================================
// Types
// ============================================================================

export type OctokitClient = InstanceType<typeof GitHub>;

/**
 * Repository context extracted from GitHub Actions environment
 */
export interface RepoContext {
  owner: string;
  repo: string;
  pullNumber: number;
}

/**
 * Configuration for GitHub client operations
 */
export interface GitHubClientOptions {
  token: string;
  dryRun?: boolean;
}

/**
 * Represents a file changed in a pull request
 */
export interface PullRequestFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Represents a single line in a diff
 */
export interface DiffLine {
  type: 'addition' | 'deletion' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Represents a parsed diff hunk with line mappings
 */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  content: string;
  lines: DiffLine[];
}

/**
 * Extended file info with parsed diff hunks
 */
export interface ParsedPullRequestFile extends PullRequestFile {
  hunks: DiffHunk[];
}

/**
 * Represents a review comment to be posted
 */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  side?: 'LEFT' | 'RIGHT';
}

/**
 * Multi-line review comment (extends ReviewComment)
 */
export interface MultiLineReviewComment extends ReviewComment {
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
}

/**
 * Represents a complete code review
 */
export interface CodeReview {
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments: MultiLineReviewComment[];
}

/**
 * Rate limit information from GitHub API
 */
export interface RateLimitInfo {
  remaining: number;
  reset: Date;
  limit: number;
}

/**
 * Result of posting a review
 */
export interface PostReviewResult {
  reviewId: number;
  htmlUrl: string;
  commentsPosted: number;
}

/**
 * Custom error for GitHub API operations
 */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly rateLimitInfo?: RateLimitInfo
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * Error for rate limit exceeded
 */
export class RateLimitError extends GitHubApiError {
  constructor(
    message: string,
    public readonly resetAt: Date,
    rateLimitInfo: RateLimitInfo
  ) {
    super(message, 403, rateLimitInfo);
    this.name = 'RateLimitError';
  }
}

// ============================================================================
// Client Functions
// ============================================================================

/**
 * Creates an authenticated Octokit client from GITHUB_TOKEN
 */
export function createGitHubClient(
  options: GitHubClientOptions
): OctokitClient {
  return github.getOctokit(options.token);
}

/**
 * Extracts repo context from GitHub Actions environment
 */
export function getRepoContext(): RepoContext {
  const { owner, repo } = github.context.repo;
  const pullNumber = github.context.payload.pull_request?.number;

  if (pullNumber === undefined) {
    throw new Error(
      `This action must be run in a pull request context (current event: ${github.context.eventName}). ` +
        'Ensure the workflow is triggered by pull_request or pull_request_target events.'
    );
  }

  return { owner, repo, pullNumber };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetches the raw diff for a pull request
 * Uses pulls.get() with mediaType: { format: 'diff' }
 */
export async function fetchPullRequestDiff(
  client: OctokitClient,
  context: RepoContext
): Promise<string> {
  const response = await withRetry(async () => {
    return client.rest.pulls.get({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      mediaType: { format: 'diff' },
    });
  });

  // When requesting diff format, response.data is the raw diff string
  return response.data as unknown as string;
}

/**
 * Fetches list of changed files with patch data
 * Uses pulls.listFiles() endpoint with pagination
 */
export async function fetchPullRequestFiles(
  client: OctokitClient,
  context: RepoContext
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  let page = 1;
  const perPage = 100;
  const maxPages = 50; // Safety limit: 5000 files max

  // Paginate through all files
  while (page <= maxPages) {
    const response = await withRetry(async () => {
      return client.rest.pulls.listFiles({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        per_page: perPage,
        page,
      });
    });

    for (const file of response.data) {
      const prFile: PullRequestFile = {
        filename: file.filename,
        status: file.status as PullRequestFile['status'],
        additions: file.additions,
        deletions: file.deletions,
      };

      if (file.patch !== undefined) {
        prFile.patch = file.patch;
      }

      files.push(prFile);
    }

    // Check if there are more pages
    if (response.data.length < perPage) {
      break;
    }
    page++;
  }

  return files;
}

/**
 * Posts a batched code review with all comments
 * Uses pulls.createReview() - single API call for all comments
 */
export async function postReview(
  client: OctokitClient,
  context: RepoContext,
  review: CodeReview,
  options?: { dryRun?: boolean }
): Promise<PostReviewResult> {
  // Handle dry-run mode
  if (options?.dryRun === true) {
    core.info('[DRY-RUN] Would post review:');
    core.info(`  Event: ${review.event}`);
    core.info(
      `  Body: ${review.body.substring(0, 100)}${review.body.length > 100 ? '...' : ''}`
    );
    core.info(`  Comments: ${String(review.comments.length)}`);

    for (const comment of review.comments) {
      const lineInfo =
        comment.startLine !== undefined
          ? `${String(comment.startLine)}-${String(comment.line)}`
          : String(comment.line);
      core.info(`    - ${comment.path}:${lineInfo}`);
      core.info(
        `      ${comment.body.substring(0, 80)}${comment.body.length > 80 ? '...' : ''}`
      );
    }

    return {
      reviewId: 0,
      htmlUrl: '',
      commentsPosted: review.comments.length,
    };
  }

  // Format comments for GitHub API
  const apiComments = review.comments.map((comment) => {
    const base = {
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: comment.side ?? ('RIGHT' as const),
    };

    // Add multi-line fields if present
    if (comment.startLine !== undefined) {
      return {
        ...base,
        start_line: comment.startLine,
        start_side: comment.startSide ?? ('RIGHT' as const),
      };
    }

    return base;
  });

  const response = await withRetry(async () => {
    return client.rest.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      body: review.body,
      event: review.event,
      comments: apiComments,
    });
  });

  return {
    reviewId: response.data.id,
    htmlUrl: response.data.html_url,
    commentsPosted: review.comments.length,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a GitHub suggestion comment with proper formatting
 * Format: ```suggestion\n<suggested_code>\n```
 */
export function createSuggestionComment(suggestedCode: string): string {
  return `\`\`\`suggestion\n${suggestedCode}\n\`\`\``;
}

/**
 * Wraps a message with a suggestion block
 */
export function formatSuggestionWithMessage(
  message: string,
  suggestedCode: string
): string {
  return `${message}\n\n${createSuggestionComment(suggestedCode)}`;
}

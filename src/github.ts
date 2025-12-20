/**
 * GitHub API integration for fetching PR diffs and posting review comments
 *
 * This module will be implemented in FORGE-53
 */

import type { GitHub } from '@actions/github/lib/utils';

export type OctokitClient = InstanceType<typeof GitHub>;

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
 * Represents a review comment to be posted
 */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  side?: 'LEFT' | 'RIGHT';
}

/**
 * Represents a complete code review
 */
export interface CodeReview {
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments: ReviewComment[];
}

// TODO: Implement in FORGE-53
// - fetchPullRequestDiff(octokit, owner, repo, prNumber)
// - parseDiffToFiles(diff)
// - postReviewComments(octokit, owner, repo, prNumber, review)
// - createSuggestionComment(original, suggested)

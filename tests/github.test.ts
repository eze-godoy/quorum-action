import { describe, expect, it, vi } from 'vitest';

import {
  createGitHubClient,
  createSuggestionComment,
  fetchPullRequestDiff,
  fetchPullRequestFiles,
  formatSuggestionWithMessage,
  getRepoContext,
  GitHubApiError,
  postReview,
  RateLimitError,
  type CodeReview,
  type OctokitClient,
  type RepoContext,
} from '../src/github';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));

// Mock @actions/github
vi.mock('@actions/github', () => ({
  getOctokit: vi.fn((token: string) => ({
    _token: token,
    rest: {
      pulls: {
        get: vi.fn(),
        listFiles: vi.fn(),
        createReview: vi.fn(),
      },
    },
  })),
  context: {
    repo: {
      owner: 'test-owner',
      repo: 'test-repo',
    },
    payload: {
      pull_request: {
        number: 123,
      },
    },
  },
}));

// Mock retry module to avoid actual delays
vi.mock('../src/retry', () => ({
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

describe('Error Classes', () => {
  describe('GitHubApiError', () => {
    it('creates error with status code', () => {
      const error = new GitHubApiError('Not found', 404);
      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('GitHubApiError');
    });

    it('includes rate limit info', () => {
      const rateLimitInfo = {
        remaining: 0,
        reset: new Date(),
        limit: 5000,
      };
      const error = new GitHubApiError('Rate limited', 403, rateLimitInfo);
      expect(error.rateLimitInfo).toEqual(rateLimitInfo);
    });
  });

  describe('RateLimitError', () => {
    it('creates error with reset time', () => {
      const resetAt = new Date('2025-01-01T00:00:00Z');
      const rateLimitInfo = {
        remaining: 0,
        reset: resetAt,
        limit: 5000,
      };
      const error = new RateLimitError('Rate limited', resetAt, rateLimitInfo);

      expect(error.message).toBe('Rate limited');
      expect(error.statusCode).toBe(403);
      expect(error.resetAt).toEqual(resetAt);
      expect(error.name).toBe('RateLimitError');
    });
  });
});

describe('createGitHubClient', () => {
  it('creates client with token', () => {
    const client = createGitHubClient({ token: 'test-token' });
    expect(client).toBeDefined();
  });
});

describe('getRepoContext', () => {
  it('extracts context from GitHub Actions environment', () => {
    const context = getRepoContext();

    expect(context).toEqual({
      owner: 'test-owner',
      repo: 'test-repo',
      pullNumber: 123,
    });
  });
});

describe('fetchPullRequestDiff', () => {
  it('fetches diff with correct parameters', async () => {
    const mockClient = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: 'diff content' }),
        },
      },
    } as unknown as OctokitClient;

    const context: RepoContext = {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 42,
    };
    const result = await fetchPullRequestDiff(mockClient, context);

    expect(mockClient.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 42,
      mediaType: { format: 'diff' },
    });
    expect(result).toBe('diff content');
  });
});

describe('fetchPullRequestFiles', () => {
  it('fetches files with pagination', async () => {
    const mockFiles = [
      {
        filename: 'file1.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
        patch: '@@ -1,3 +1,4 @@\n content',
      },
      {
        filename: 'file2.ts',
        status: 'added',
        additions: 20,
        deletions: 0,
        patch: '@@ -0,0 +1,10 @@\n new content',
      },
    ];

    const mockClient = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({ data: mockFiles }),
        },
      },
    } as unknown as OctokitClient;

    const context: RepoContext = {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 42,
    };
    const result = await fetchPullRequestFiles(mockClient, context);

    expect(mockClient.rest.pulls.listFiles).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe('file1.ts');
    expect(result[1].status).toBe('added');
  });

  it('handles files without patch (binary files)', async () => {
    const mockFiles = [
      {
        filename: 'image.png',
        status: 'added',
        additions: 0,
        deletions: 0,
        // No patch property for binary files
      },
    ];

    const mockClient = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({ data: mockFiles }),
        },
      },
    } as unknown as OctokitClient;

    const context: RepoContext = {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 42,
    };
    const result = await fetchPullRequestFiles(mockClient, context);

    expect(result).toHaveLength(1);
    expect(result[0].patch).toBeUndefined();
  });

  it('paginates through multiple pages', async () => {
    // Create 100 files for first page
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      filename: `file${String(i)}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }));

    // Create 50 files for second page
    const secondPage = Array.from({ length: 50 }, (_, i) => ({
      filename: `file${String(100 + i)}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }));

    const mockClient = {
      rest: {
        pulls: {
          listFiles: vi
            .fn()
            .mockResolvedValueOnce({ data: firstPage })
            .mockResolvedValueOnce({ data: secondPage }),
        },
      },
    } as unknown as OctokitClient;

    const context: RepoContext = {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 42,
    };
    const result = await fetchPullRequestFiles(mockClient, context);

    expect(mockClient.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(150);
  });
});

describe('postReview', () => {
  const context: RepoContext = { owner: 'owner', repo: 'repo', pullNumber: 42 };

  const review: CodeReview = {
    body: 'Test review body',
    event: 'COMMENT',
    comments: [
      {
        path: 'src/file.ts',
        line: 10,
        body: 'Test comment',
      },
      {
        path: 'src/file.ts',
        line: 25,
        body: 'Multi-line comment',
        startLine: 20,
        side: 'RIGHT',
        startSide: 'RIGHT',
      },
    ],
  };

  it('posts review with single-line comments', async () => {
    const mockClient = {
      rest: {
        pulls: {
          createReview: vi.fn().mockResolvedValue({
            data: { id: 12345, html_url: 'https://github.com/...' },
          }),
        },
      },
    } as unknown as OctokitClient;

    const result = await postReview(mockClient, context, review);

    expect(mockClient.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 42,
      body: 'Test review body',
      event: 'COMMENT',
      comments: [
        {
          path: 'src/file.ts',
          line: 10,
          body: 'Test comment',
          side: 'RIGHT',
        },
        {
          path: 'src/file.ts',
          line: 25,
          body: 'Multi-line comment',
          side: 'RIGHT',
          start_line: 20,
          start_side: 'RIGHT',
        },
      ],
    });

    expect(result.reviewId).toBe(12345);
    expect(result.commentsPosted).toBe(2);
  });

  it('handles dry-run mode', async () => {
    const mockClient = {
      rest: {
        pulls: {
          createReview: vi.fn(),
        },
      },
    } as unknown as OctokitClient;

    const result = await postReview(mockClient, context, review, {
      dryRun: true,
    });

    expect(mockClient.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(result.reviewId).toBe(0);
    expect(result.htmlUrl).toBe('');
    expect(result.commentsPosted).toBe(2);
  });
});

describe('createSuggestionComment', () => {
  it('formats suggestion with code block', () => {
    const suggestion = createSuggestionComment('const x = 1;');
    expect(suggestion).toBe('```suggestion\nconst x = 1;\n```');
  });

  it('handles multi-line suggestions', () => {
    const code = 'function hello() {\n  return "world";\n}';
    const suggestion = createSuggestionComment(code);
    expect(suggestion).toBe(
      '```suggestion\nfunction hello() {\n  return "world";\n}\n```'
    );
  });
});

describe('formatSuggestionWithMessage', () => {
  it('combines message with suggestion', () => {
    const result = formatSuggestionWithMessage(
      'Consider using const',
      'const x = 1;'
    );
    expect(result).toBe(
      'Consider using const\n\n```suggestion\nconst x = 1;\n```'
    );
  });
});

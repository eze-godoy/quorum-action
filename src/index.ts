import * as core from '@actions/core';
import { minimatch } from 'minimatch';

import { getConfig } from './config.js';
import { parsePatch } from './diff-parser.js';
import {
  createGitHubClient,
  fetchPullRequestFiles,
  getRepoContext,
  type ParsedPullRequestFile,
  type PullRequestFile,
} from './github.js';

/**
 * Filters files based on ignore patterns from configuration
 */
function filterIgnoredFiles(
  files: PullRequestFile[],
  ignorePatterns: string[]
): PullRequestFile[] {
  return files.filter((file) => {
    for (const pattern of ignorePatterns) {
      if (minimatch(file.filename, pattern)) {
        core.debug(
          `Ignoring file ${file.filename} (matched pattern: ${pattern})`
        );
        return false;
      }
    }
    return true;
  });
}

/**
 * Parses file patches into structured diff data
 */
function parseFilesWithHunks(
  files: PullRequestFile[]
): ParsedPullRequestFile[] {
  return files.map((file) => ({
    ...file,
    hunks: file.patch !== undefined ? parsePatch(file.patch) : [],
  }));
}

async function run(): Promise<void> {
  try {
    core.info('Starting Quorum AI Code Review');

    // Get action inputs
    const awsRoleArn = core.getInput('aws-role-arn', { required: true });
    const awsRegion = core.getInput('aws-region') || 'us-east-1';
    const model =
      core.getInput('model') || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    const configPath = core.getInput('config-path') || '.quorum.yaml';
    const reviewDepth = core.getInput('review-depth') || 'standard';
    const failOnErrors = core.getInput('fail-on-errors') === 'true';
    const dryRun = core.getInput('dry-run') === 'true';
    const githubToken = core.getInput('github-token', { required: true });

    core.debug(`AWS Role ARN: ${awsRoleArn}`);
    core.debug(`AWS Region: ${awsRegion}`);
    core.debug(`Model: ${model}`);
    core.debug(`Config Path: ${configPath}`);
    core.debug(`Review Depth: ${reviewDepth}`);
    core.debug(`Fail on Errors: ${String(failOnErrors)}`);
    core.debug(`Dry Run: ${String(dryRun)}`);

    // Load configuration
    const config = await getConfig(configPath);
    core.debug(`Loaded config: ${JSON.stringify(config)}`);

    // FORGE-53: GitHub Integration
    core.info('Initializing GitHub client...');
    const client = createGitHubClient({ token: githubToken, dryRun });
    const context = getRepoContext();

    core.info(`Fetching PR #${String(context.pullNumber)} files...`);
    const allFiles = await fetchPullRequestFiles(client, context);
    core.info(`Found ${String(allFiles.length)} changed files`);

    // Filter files based on config.ignore patterns
    const reviewableFiles = filterIgnoredFiles(allFiles, config.ignore);
    core.info(
      `${String(reviewableFiles.length)} files after applying ignore patterns`
    );

    if (reviewableFiles.length === 0) {
      core.info('No files to review after applying ignore patterns');
      core.setOutput('review-summary', 'No files to review');
      core.setOutput('issues-found', '0');
      core.setOutput('cost-usd', '0.00');
      return;
    }

    // Parse patches to get structured diff data
    const parsedFiles = parseFilesWithHunks(reviewableFiles);

    // Log file summary
    for (const file of parsedFiles) {
      core.debug(
        `  ${file.status}: ${file.filename} (+${String(file.additions)}/-${String(file.deletions)}, ${String(file.hunks.length)} hunks)`
      );
    }

    // TODO FORGE-54: Authenticate to AWS Bedrock via OIDC
    // const bedrockClient = await createBedrockClient({ roleArn: awsRoleArn, region: awsRegion });

    // TODO FORGE-54: Send code for review to Bedrock model
    // const reviewResult = await invokeBedrockReview(bedrockClient, parsedFiles, {
    //   model,
    //   depth: reviewDepth,
    //   config,
    // });

    // TODO FORGE-55: Parse and post review comments
    // if (reviewResult.comments.length > 0) {
    //   const result = await postReview(client, context, reviewResult, { dryRun });
    //   core.info(`Posted review with ${result.commentsPosted} comments`);
    //   core.setOutput('review-summary', reviewResult.summary);
    //   core.setOutput('issues-found', String(reviewResult.comments.length));
    // }

    // Set outputs (placeholder until FORGE-54/55)
    core.setOutput('review-summary', 'Review completed successfully');
    core.setOutput('issues-found', '0');
    core.setOutput('cost-usd', '0.00');

    core.info('Quorum AI Code Review completed');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('Action failed with an unknown error');
    }
  }
}

void run();

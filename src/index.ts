import * as core from '@actions/core';
import { minimatch } from 'minimatch';

import { calculateCost, createBedrockClient, invokeModel } from './bedrock.js';
import { getConfig, type ReviewDepth } from './config.js';
import { parsePatch } from './diff-parser.js';
import {
  createGitHubClient,
  fetchPullRequestFiles,
  getRepoContext,
  postReview,
  type ParsedPullRequestFile,
  type PullRequestFile,
} from './github.js';
import { buildReviewPrompt } from './prompts.js';
import { parseModelResponse, toCodeReview } from './review-parser.js';

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

/**
 * Validates and normalizes review depth input
 */
function normalizeReviewDepth(input: string): ReviewDepth {
  const validDepths: ReviewDepth[] = ['quick', 'standard', 'deep', 'security'];
  if (validDepths.includes(input as ReviewDepth)) {
    return input as ReviewDepth;
  }
  core.warning(`Invalid review depth "${input}", using "standard"`);
  return 'standard';
}

async function run(): Promise<void> {
  try {
    core.info('Starting Quorum AI Code Review');

    // Get action inputs
    const awsRoleArn = core.getInput('aws-role-arn', { required: true });
    const awsRegion = core.getInput('aws-region') || 'us-east-1';
    const modelInput = core.getInput('model');
    const configPath = core.getInput('config-path') || '.quorum.yaml';
    const reviewDepthInput = core.getInput('review-depth') || 'standard';
    const failOnErrors = core.getInput('fail-on-errors') === 'true';
    const dryRun = core.getInput('dry-run') === 'true';
    const githubToken = core.getInput('github-token', { required: true });

    core.debug(`AWS Role ARN: ${awsRoleArn}`);
    core.debug(`AWS Region: ${awsRegion}`);
    core.debug(`Config Path: ${configPath}`);
    core.debug(`Review Depth: ${reviewDepthInput}`);
    core.debug(`Fail on Errors: ${String(failOnErrors)}`);
    core.debug(`Dry Run: ${String(dryRun)}`);

    // Load configuration
    const config = await getConfig(configPath);

    // Apply input overrides to config
    const reviewDepth = normalizeReviewDepth(reviewDepthInput);
    if (reviewDepthInput !== 'standard') {
      config.review.depth = reviewDepth;
    }

    // Model ID: input > config > default
    const model =
      (modelInput !== '' ? modelInput : undefined) ??
      config.model.id ??
      'anthropic.claude-sonnet-4-20250514-v1:0';

    core.debug(`Model: ${model}`);
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

    // FORGE-55: Build review prompt
    core.info('Building review prompt...');
    const builtPrompt = buildReviewPrompt({ config, files: parsedFiles });
    core.debug(`Prompt version: ${builtPrompt.promptVersion}`);

    // FORGE-54: Create Bedrock client and invoke model
    core.info('Initializing AWS Bedrock client...');
    const bedrockClient = createBedrockClient({
      region: awsRegion,
      roleArn: awsRoleArn,
    });

    core.info(`Invoking model: ${model}...`);
    const modelResult = await invokeModel(bedrockClient, {
      modelId: model,
      prompt: `${builtPrompt.systemPrompt}\n\n${builtPrompt.userPrompt}`,
      maxTokens: config.model.maxTokens,
      temperature: config.model.temperature,
    });

    core.info(
      `Model response received (${String(modelResult.inputTokens)} input, ${String(modelResult.outputTokens)} output tokens, ${String(modelResult.latencyMs)}ms)`
    );

    // FORGE-55: Parse and validate model response
    core.info('Parsing model response...');
    const parsedOutput = parseModelResponse(modelResult.response, parsedFiles);

    if (!parsedOutput.success) {
      core.warning(
        `Failed to parse model response: ${parsedOutput.parseErrors.join(', ')}`
      );
      // Set outputs with error state but don't fail
      core.setOutput('review-summary', 'Failed to parse AI response');
      core.setOutput('issues-found', '0');
      core.setOutput(
        'cost-usd',
        calculateCost(
          modelResult.inputTokens,
          modelResult.outputTokens,
          config.pricing
        ).toFixed(6)
      );
      return;
    }

    core.info(
      `Found ${String(parsedOutput.stats.validComments)} issues (${String(parsedOutput.stats.invalidComments)} invalid comments skipped)`
    );

    // Convert to GitHub CodeReview format
    const review = toCodeReview(parsedOutput, builtPrompt.promptVersion);

    // Post review to GitHub
    if (review.comments.length > 0 || review.event !== 'APPROVE') {
      core.info(`Posting review (${review.event})...`);
      const result = await postReview(client, context, review, { dryRun });
      core.info(
        `Posted review with ${String(result.commentsPosted)} comments${dryRun ? ' (dry-run)' : ''}`
      );
    } else {
      core.info('No issues found, skipping review post');
    }

    // Calculate cost
    const cost = calculateCost(
      modelResult.inputTokens,
      modelResult.outputTokens,
      config.pricing
    );
    core.info(`Estimated cost: $${cost.toFixed(6)}`);

    // Set outputs
    core.setOutput(
      'review-summary',
      parsedOutput.output?.summary ?? 'Review completed'
    );
    core.setOutput('issues-found', String(parsedOutput.stats.validComments));
    core.setOutput('cost-usd', cost.toFixed(6));

    // Fail if errors found and fail-on-errors is set
    if (
      failOnErrors &&
      (parsedOutput.stats.bySeverity.critical > 0 ||
        parsedOutput.stats.bySeverity.high > 0)
    ) {
      core.setFailed(
        `Found ${String(parsedOutput.stats.bySeverity.critical)} critical and ${String(parsedOutput.stats.bySeverity.high)} high severity issues`
      );
      return;
    }

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

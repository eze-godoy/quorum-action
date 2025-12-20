import * as core from '@actions/core';

import { getConfig } from './config.js';

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

    core.debug(`AWS Role ARN: ${awsRoleArn}`);
    core.debug(`AWS Region: ${awsRegion}`);
    core.debug(`Model: ${model}`);
    core.debug(`Config Path: ${configPath}`);
    core.debug(`Review Depth: ${reviewDepth}`);
    core.debug(`Fail on Errors: ${String(failOnErrors)}`);

    // Load configuration
    const config = await getConfig(configPath);
    core.debug(`Loaded config: ${JSON.stringify(config)}`);

    // TODO: Implement in FORGE-53, FORGE-54, FORGE-55
    // 1. Fetch PR diff from GitHub API
    // 2. Authenticate to AWS Bedrock via OIDC
    // 3. Send code for review to Bedrock model
    // 4. Parse and post review comments

    // Set outputs
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

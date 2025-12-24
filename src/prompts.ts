/**
 * Prompt engineering system for AI code review
 *
 * Provides versioned prompt templates, depth profiles,
 * security/quality checklists, and prompt building utilities.
 */

import { minimatch } from 'minimatch';

import type { QuorumConfig, ReviewDepth } from './config.js';
import type { ParsedPullRequestFile, DiffHunk } from './github.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Prompt template with versioning for A/B testing
 */
export interface PromptTemplate {
  version: string;
  name: string;
  systemPrompt: string;
  userPromptTemplate: string;
}

/**
 * Depth profile configuration
 */
export interface DepthProfile {
  name: ReviewDepth;
  description: string;
  instructions: string;
  maxCommentsPerFile: number;
}

/**
 * Options for building a review prompt
 */
export interface PromptBuildOptions {
  config: QuorumConfig;
  files: ParsedPullRequestFile[];
  promptVersion?: string;
}

/**
 * Result of prompt building
 */
export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
  promptVersion: string;
}

// ============================================================================
// Security Checklist (OWASP Top 10)
// ============================================================================

const SECURITY_CHECKLIST_FULL = `## Security Checklist (OWASP Top 10)

Check for these vulnerability categories:

### A01: Broken Access Control
- Missing authorization checks
- Insecure direct object references (IDOR)
- Privilege escalation paths
- CORS misconfiguration

### A02: Cryptographic Failures
- Sensitive data in logs or error messages
- Weak or missing encryption
- Hardcoded secrets or credentials
- Insecure random number generation

### A03: Injection
- SQL injection (unparameterized queries)
- Command injection (shell execution with user input)
- XSS (cross-site scripting)
- Path traversal
- Template injection

### A04: Insecure Design
- Missing rate limiting
- Insufficient input validation
- Business logic flaws
- Missing security controls

### A05: Security Misconfiguration
- Debug mode in production
- Default credentials
- Overly permissive settings
- Missing security headers

### A06: Vulnerable Components
- Known vulnerable dependencies (if visible in diff)
- Outdated security-critical libraries

### A07: Authentication Failures
- Weak password policies
- Missing MFA considerations
- Session fixation
- Credential exposure

### A08: Data Integrity Failures
- Deserialization of untrusted data
- Missing integrity checks
- CI/CD pipeline security

### A09: Logging Failures
- Sensitive data in logs
- Missing audit trails
- Log injection

### A10: Server-Side Request Forgery (SSRF)
- Unvalidated URL inputs
- Internal resource access`;

const SECURITY_CHECKLIST_BRIEF = `## Security Awareness
Check for common security issues:
- Injection vulnerabilities (SQL, XSS, command)
- Hardcoded credentials or secrets
- Missing input validation
- Authorization bypass risks`;

// ============================================================================
// Code Quality Checklist
// ============================================================================

const QUALITY_CHECKLIST_FULL = `## Code Quality Checklist

### Naming & Readability
- Variable/function names are descriptive and consistent
- No single-letter variables (except loop counters)
- Boolean names suggest true/false (is*, has*, can*)
- Functions do one thing (single responsibility)

### Complexity
- Functions are not excessively long (>50 lines is a smell)
- Cyclomatic complexity is reasonable (avoid deeply nested conditions)
- Early returns used to reduce nesting
- Complex conditions extracted to named variables/functions

### DRY (Don't Repeat Yourself)
- No copy-pasted code blocks
- Common patterns extracted to functions
- Magic numbers/strings replaced with constants

### Error Handling
- Errors are caught and handled appropriately
- No swallowed exceptions
- User-facing errors are informative
- Error boundaries in appropriate places

### Type Safety (TypeScript)
- No 'any' types without justification
- Proper null/undefined handling
- Type assertions used sparingly
- Generics used appropriately`;

const QUALITY_CHECKLIST_BRIEF = `## Code Quality
Check for:
- Clear naming conventions
- Reasonable function complexity
- Proper error handling
- Type safety (avoid 'any')`;

// ============================================================================
// Depth Profiles
// ============================================================================

/**
 * Review depth profiles with specific instructions
 */
export const DEPTH_PROFILES: Record<ReviewDepth, DepthProfile> = {
  quick: {
    name: 'quick',
    description: 'Fast feedback on critical issues only',
    instructions: `## Review Depth: Quick

Focus ONLY on:
- Critical bugs that would cause runtime errors
- Security vulnerabilities (injection, auth bypass)
- Obvious logic errors

Skip: Style issues, minor improvements, documentation.
Be concise. Maximum 3 comments per file.`,
    maxCommentsPerFile: 3,
  },

  standard: {
    name: 'standard',
    description: 'Balanced review covering common issues',
    instructions: `## Review Depth: Standard

Review for:
- Bugs and potential runtime errors
- Security issues
- Performance concerns
- Code readability and maintainability
- Missing error handling

Provide helpful suggestions but avoid nitpicking style unless it impacts readability.`,
    maxCommentsPerFile: 10,
  },

  deep: {
    name: 'deep',
    description: 'Thorough analysis including design feedback',
    instructions: `## Review Depth: Deep (Thorough Analysis)

Conduct comprehensive review:
- All bug categories and edge cases
- Security vulnerabilities at all levels
- Performance and scalability concerns
- Design patterns and architectural decisions
- Test coverage gaps
- Documentation completeness
- Naming conventions and code organization
- DRY principle violations
- Potential future maintenance issues

Be thorough but constructive.`,
    maxCommentsPerFile: 20,
  },

  security: {
    name: 'security',
    description: 'Security-focused review with OWASP Top 10',
    instructions: `## Review Depth: Security Focus

Primary focus on security vulnerabilities:
- OWASP Top 10 issues (see security checklist below)
- Authentication and authorization flaws
- Data exposure risks
- Input validation gaps
- Cryptographic weaknesses

Also flag any bugs that could have security implications.`,
    maxCommentsPerFile: 15,
  },
};

/**
 * Gets depth profile for a given depth
 */
export function getDepthProfile(depth: ReviewDepth): DepthProfile {
  return DEPTH_PROFILES[depth];
}

// ============================================================================
// Prompt Templates
// ============================================================================

/**
 * Version 1.0.0 prompt template
 */
const PROMPT_V1: PromptTemplate = {
  version: '1.0.0',
  name: 'standard-review-v1',
  systemPrompt: `You are an expert code reviewer analyzing pull request changes.
Your task is to identify issues and provide actionable feedback.

## Your Responsibilities
1. Identify bugs, security vulnerabilities, and code quality issues
2. Suggest specific improvements with code examples when helpful
3. Be constructive and educational in your feedback
4. Focus only on the changed lines in the diff

## Output Format
You MUST respond with valid JSON matching this exact structure:
{
  "summary": "Brief overall assessment (2-3 sentences)",
  "overallSeverity": "none" | "low" | "medium" | "high" | "critical",
  "comments": [
    {
      "path": "filename",
      "line": <line number in new file>,
      "endLine": <optional, for multi-line comments>,
      "severity": "critical" | "high" | "medium" | "low",
      "category": "security" | "bug" | "performance" | "style" | "maintainability",
      "message": "Clear explanation of the issue",
      "suggestion": "Optional code suggestion"
    }
  ],
  "promptVersion": "1.0.0"
}

## Rules
- Line numbers MUST reference lines visible in the diff (RIGHT side for additions/context)
- Only comment on lines within the provided hunks
- Use severity appropriately: critical for security/data loss, high for bugs, medium for improvements, low for style
- For the "suggestion" field, provide ONLY the replacement code as a plain string (no markdown, no backticks, no code blocks). We will format it for GitHub.
- All strings in JSON must be properly escaped (newlines as \\n, quotes as \\", etc.)
- If no issues are found, return an empty comments array with overallSeverity "none"`,

  userPromptTemplate: `{{DEPTH_INSTRUCTIONS}}

{{SECURITY_INSTRUCTIONS}}

{{QUALITY_CHECKLIST}}

{{CUSTOM_INSTRUCTIONS}}

## Files to Review

{{FILES_CONTEXT}}

Provide your review as JSON.`,
};

/**
 * Registry of available prompt templates
 */
const PROMPT_REGISTRY: Record<string, PromptTemplate> = {
  '1.0.0': PROMPT_V1,
};

/**
 * Gets prompt template by version
 * Defaults to latest version if not specified
 */
export function getPromptTemplate(version?: string): PromptTemplate {
  if (version !== undefined) {
    const template = PROMPT_REGISTRY[version];
    if (template !== undefined) {
      return template;
    }
  }
  return PROMPT_V1;
}

/**
 * Gets all available prompt template versions
 */
export function getAvailablePromptVersions(): string[] {
  return Object.keys(PROMPT_REGISTRY);
}

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Gets security instructions based on review depth and focus
 */
export function getSecurityInstructions(
  depth: ReviewDepth,
  focus: string[]
): string {
  // Full checklist for security depth
  if (depth === 'security') {
    return SECURITY_CHECKLIST_FULL;
  }

  // Brief checklist if security is in focus areas
  if (focus.includes('security')) {
    return SECURITY_CHECKLIST_BRIEF;
  }

  // Standard/deep include brief security awareness
  if (depth === 'standard' || depth === 'deep') {
    return SECURITY_CHECKLIST_BRIEF;
  }

  // Quick skips security unless explicitly focused
  return '';
}

/**
 * Gets quality instructions based on review depth and focus
 */
export function getQualityInstructions(
  depth: ReviewDepth,
  focus: string[]
): string {
  // Skip for quick reviews
  if (depth === 'quick') {
    return '';
  }

  // Full checklist for deep or if best-practices is in focus
  if (depth === 'deep' || focus.includes('best-practices')) {
    return QUALITY_CHECKLIST_FULL;
  }

  // Brief checklist for standard
  return QUALITY_CHECKLIST_BRIEF;
}

/**
 * Builds custom instructions section from config
 */
function buildCustomInstructions(
  config: QuorumConfig,
  files: ParsedPullRequestFile[]
): string {
  const sections: string[] = [];

  // Global custom instructions
  if (config.review.instructions !== undefined) {
    sections.push(
      `## Project-Specific Instructions\n${config.review.instructions}`
    );
  }

  // Path-specific instructions
  const pathInstructions = getPathSpecificInstructions(config, files);
  if (pathInstructions.length > 0) {
    sections.push(
      `## Path-Specific Instructions\n${pathInstructions.join('\n\n')}`
    );
  }

  return sections.join('\n\n');
}

/**
 * Gets path-specific instructions for files being reviewed
 */
function getPathSpecificInstructions(
  config: QuorumConfig,
  files: ParsedPullRequestFile[]
): string[] {
  const instructions: string[] = [];

  for (const pathConfig of config.paths) {
    if (pathConfig.instructions === undefined) {
      continue;
    }

    // Find files matching this pattern
    const matchingFiles = files
      .filter((f) => minimatch(f.filename, pathConfig.pattern))
      .map((f) => f.filename);

    if (matchingFiles.length > 0) {
      instructions.push(
        `For files matching \`${pathConfig.pattern}\` (${matchingFiles.join(', ')}):\n${pathConfig.instructions}`
      );
    }
  }

  return instructions;
}

/**
 * Gets the effective review depth for a file (considering path overrides)
 */
export function getEffectiveDepth(
  filename: string,
  config: QuorumConfig
): ReviewDepth {
  for (const pathConfig of config.paths) {
    if (
      pathConfig.depth !== undefined &&
      minimatch(filename, pathConfig.pattern)
    ) {
      return pathConfig.depth;
    }
  }
  return config.review.depth;
}

/**
 * Gets all valid line numbers from hunks (for RIGHT side comments)
 */
export function getValidLineNumbers(hunks: DiffHunk[]): number[] {
  const lineNumbers: number[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (
        line.newLineNumber !== undefined &&
        (line.type === 'addition' || line.type === 'context')
      ) {
        lineNumbers.push(line.newLineNumber);
      }
    }
  }

  return [...new Set(lineNumbers)].sort((a, b) => a - b);
}

/**
 * Formats diff with line numbers for clarity
 */
function formatDiffWithLineNumbers(hunks: DiffHunk[]): string {
  const lines: string[] = [];

  for (const hunk of hunks) {
    // Add hunk header
    const headerLine = hunk.content.split('\n')[0];
    if (headerLine !== undefined) {
      lines.push(headerLine);
    }

    for (const line of hunk.lines) {
      const lineNum = line.newLineNumber ?? line.oldLineNumber ?? '?';
      const prefix =
        line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' ';
      lines.push(`${prefix}[L${String(lineNum)}] ${line.content}`);
    }
  }

  return lines.join('\n');
}

/**
 * Builds context for a single file
 */
function buildSingleFileContext(
  file: ParsedPullRequestFile,
  depth: ReviewDepth
): string {
  const header = `### File: ${file.filename}
Status: ${file.status} (+${String(file.additions)}/-${String(file.deletions)})
Review Depth: ${depth}`;

  if (file.hunks.length === 0) {
    return `${header}\n(No diff content - binary or empty file)`;
  }

  // Build diff with line numbers
  const diffContent = formatDiffWithLineNumbers(file.hunks);
  const validLines = getValidLineNumbers(file.hunks);
  const validLinesStr =
    validLines.length > 20
      ? `${validLines.slice(0, 10).join(', ')}, ... (${String(validLines.length)} total)`
      : validLines.join(', ');

  return `${header}

\`\`\`diff
${diffContent}
\`\`\`

Valid line numbers for comments: ${validLinesStr}`;
}

/**
 * Builds the files context section showing diffs
 */
function buildFilesContext(
  files: ParsedPullRequestFile[],
  config: QuorumConfig
): string {
  const fileContexts: string[] = [];

  for (const file of files) {
    const effectiveDepth = getEffectiveDepth(file.filename, config);
    const context = buildSingleFileContext(file, effectiveDepth);
    fileContexts.push(context);
  }

  return fileContexts.join('\n\n---\n\n');
}

/**
 * Builds the complete prompt for a code review
 */
export function buildReviewPrompt(options: PromptBuildOptions): BuiltPrompt {
  const { config, files, promptVersion } = options;
  const template = getPromptTemplate(promptVersion);

  // Get base depth and focus from config
  const baseDepth = config.review.depth;
  const focus = config.review.focus;

  // Build the user prompt by replacing placeholders
  let userPrompt = template.userPromptTemplate;

  // Depth instructions
  const depthProfile = getDepthProfile(baseDepth);
  userPrompt = userPrompt.replace(
    '{{DEPTH_INSTRUCTIONS}}',
    depthProfile.instructions
  );

  // Security instructions
  const securityInstructions = getSecurityInstructions(baseDepth, focus);
  userPrompt = userPrompt.replace(
    '{{SECURITY_INSTRUCTIONS}}',
    securityInstructions
  );

  // Quality checklist
  const qualityInstructions = getQualityInstructions(baseDepth, focus);
  userPrompt = userPrompt.replace('{{QUALITY_CHECKLIST}}', qualityInstructions);

  // Custom instructions (from config.review.instructions + path-specific)
  const customInstructions = buildCustomInstructions(config, files);
  userPrompt = userPrompt.replace(
    '{{CUSTOM_INSTRUCTIONS}}',
    customInstructions
  );

  // Files context
  const filesContext = buildFilesContext(files, config);
  userPrompt = userPrompt.replace('{{FILES_CONTEXT}}', filesContext);

  return {
    systemPrompt: template.systemPrompt,
    userPrompt,
    promptVersion: template.version,
  };
}

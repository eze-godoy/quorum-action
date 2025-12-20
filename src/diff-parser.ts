/**
 * Unified diff parsing utilities
 *
 * Parses git diff output into structured data for code review
 */

import type {
  DiffHunk,
  DiffLine,
  ParsedPullRequestFile,
  PullRequestFile,
} from './github.js';

/**
 * Parsed hunk header information
 */
export interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/**
 * Regular expression to match hunk headers
 * Format: @@ -oldStart,oldCount +newStart,newCount @@
 */
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Regular expression to match file headers in unified diff
 * Format: diff --git a/path b/path
 */
const FILE_HEADER_REGEX = /^diff --git a\/(.+) b\/(.+)$/;

/**
 * Parses a hunk header string into structured data
 *
 * @param header - Hunk header line (e.g., "@@ -10,5 +10,7 @@")
 * @returns Parsed header info or null if invalid
 *
 * @example
 * parseHunkHeader('@@ -10,5 +12,7 @@')
 * // Returns: { oldStart: 10, oldCount: 5, newStart: 12, newCount: 7 }
 */
export function parseHunkHeader(header: string): HunkHeader | null {
  const match = HUNK_HEADER_REGEX.exec(header);
  if (match === null) {
    return null;
  }

  const oldStartStr = match[1];
  const newStartStr = match[3];

  // These should always be present if regex matched
  if (oldStartStr === undefined || newStartStr === undefined) {
    return null;
  }

  return {
    oldStart: parseInt(oldStartStr, 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(newStartStr, 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
  };
}

/**
 * Parses a patch string (single file diff) into structured hunks
 *
 * @param patch - Git patch content for a single file
 * @returns Array of parsed diff hunks
 *
 * @example
 * const hunks = parsePatch(`@@ -1,3 +1,4 @@
 *  context line
 * +added line
 *  more context`);
 */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = patch.split('\n');

  let currentHunk: DiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of lines) {
    // Check for hunk header
    const header = parseHunkHeader(line);
    if (header !== null) {
      // Save previous hunk if exists
      if (currentHunk !== null) {
        hunks.push(currentHunk);
      }

      // Start new hunk
      currentHunk = {
        ...header,
        content: line,
        lines: [],
      };
      oldLineNumber = header.oldStart;
      newLineNumber = header.newStart;
      continue;
    }

    // Skip if no current hunk (e.g., file headers)
    if (currentHunk === null) {
      continue;
    }

    // Parse diff line
    const diffLine = parseDiffLine(line, oldLineNumber, newLineNumber);
    if (diffLine !== null) {
      currentHunk.lines.push(diffLine);
      currentHunk.content += '\n' + line;

      // Update line numbers based on line type
      switch (diffLine.type) {
        case 'context':
          oldLineNumber++;
          newLineNumber++;
          break;
        case 'addition':
          newLineNumber++;
          break;
        case 'deletion':
          oldLineNumber++;
          break;
      }
    }
  }

  // Don't forget the last hunk
  if (currentHunk !== null) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Parses a single diff line into structured data
 */
function parseDiffLine(
  line: string,
  oldLineNumber: number,
  newLineNumber: number
): DiffLine | null {
  if (line.startsWith('+')) {
    return {
      type: 'addition',
      content: line.substring(1),
      newLineNumber,
    };
  }

  if (line.startsWith('-')) {
    return {
      type: 'deletion',
      content: line.substring(1),
      oldLineNumber,
    };
  }

  if (line.startsWith(' ') || line === '') {
    return {
      type: 'context',
      content: line.startsWith(' ') ? line.substring(1) : line,
      oldLineNumber,
      newLineNumber,
    };
  }

  // Skip other lines (e.g., "\ No newline at end of file")
  return null;
}

/**
 * Parses a complete unified diff into structured file data
 *
 * @param diffText - Complete git diff output
 * @returns Array of parsed files with hunks
 */
export function parseDiff(diffText: string): ParsedPullRequestFile[] {
  const files: ParsedPullRequestFile[] = [];
  const lines = diffText.split('\n');

  let currentFile: ParsedPullRequestFile | null = null;
  let currentPatch = '';
  let inPatch = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }

    // Check for new file header
    const fileMatch = FILE_HEADER_REGEX.exec(line);
    if (fileMatch !== null) {
      // Save previous file if exists
      if (currentFile !== null && currentPatch !== '') {
        currentFile.patch = currentPatch.trim();
        currentFile.hunks = parsePatch(currentPatch);
        files.push(currentFile);
      }

      // Determine file status from subsequent lines
      const status = determineFileStatus(lines, i);
      const filename = fileMatch[2];

      if (filename === undefined) {
        continue;
      }

      currentFile = {
        filename, // Use 'b' path (new file path)
        status,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      currentPatch = '';
      inPatch = false;
      continue;
    }

    // Start collecting patch content at hunk header
    if (line.startsWith('@@')) {
      inPatch = true;
    }

    if (inPatch && currentFile !== null) {
      currentPatch += line + '\n';

      // Count additions and deletions
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.deletions++;
      }
    }
  }

  // Don't forget the last file
  if (currentFile !== null && currentPatch !== '') {
    currentFile.patch = currentPatch.trim();
    currentFile.hunks = parsePatch(currentPatch);
    files.push(currentFile);
  }

  return files;
}

/**
 * Determines file status from diff metadata lines
 */
function determineFileStatus(
  lines: string[],
  startIndex: number
): PullRequestFile['status'] {
  // Look at the next few lines for status indicators
  for (
    let i = startIndex + 1;
    i < Math.min(startIndex + 5, lines.length);
    i++
  ) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }

    if (line.startsWith('new file mode')) {
      return 'added';
    }
    if (line.startsWith('deleted file mode')) {
      return 'removed';
    }
    if (line.startsWith('rename from')) {
      return 'renamed';
    }
    if (line.startsWith('copy from')) {
      return 'copied';
    }
    // Stop at next file or hunk
    if (line.startsWith('diff --git') || line.startsWith('@@')) {
      break;
    }
  }

  return 'modified';
}

/**
 * Maps a line number to its position in the diff (1-indexed from hunk start)
 *
 * GitHub requires the 'position' for review comments, which is the line number
 * in the unified diff view, starting from 1 for each hunk.
 *
 * @param hunks - Parsed diff hunks
 * @param lineNumber - Line number in the file
 * @param side - Which side of the diff ('LEFT' for old, 'RIGHT' for new)
 * @returns Position in diff, or null if line not found
 */
export function mapLineToPosition(
  hunks: DiffHunk[],
  lineNumber: number,
  side: 'LEFT' | 'RIGHT'
): number | null {
  let position = 0;

  for (const hunk of hunks) {
    // Position 1 is the hunk header
    position++;

    for (const line of hunk.lines) {
      position++;

      const targetLineNumber =
        side === 'RIGHT' ? line.newLineNumber : line.oldLineNumber;

      if (targetLineNumber === lineNumber) {
        // Verify line is on the correct side
        if (
          side === 'RIGHT' &&
          (line.type === 'addition' || line.type === 'context')
        ) {
          return position;
        }
        if (
          side === 'LEFT' &&
          (line.type === 'deletion' || line.type === 'context')
        ) {
          return position;
        }
      }
    }
  }

  return null;
}

/**
 * Checks if a line number exists within the diff hunks
 *
 * @param hunks - Parsed diff hunks
 * @param lineNumber - Line number to check
 * @param side - Which side of the diff
 * @returns True if line is reviewable (in diff)
 */
export function isLineInDiff(
  hunks: DiffHunk[],
  lineNumber: number,
  side: 'LEFT' | 'RIGHT'
): boolean {
  return mapLineToPosition(hunks, lineNumber, side) !== null;
}

/**
 * Gets the line content at a specific position in the new file
 *
 * @param hunks - Parsed diff hunks
 * @param lineNumber - Line number in new file
 * @returns Line content or null if not found
 */
export function getLineContent(
  hunks: DiffHunk[],
  lineNumber: number
): string | null {
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber === lineNumber) {
        return line.content;
      }
    }
  }
  return null;
}

/**
 * Gets a range of lines from the new file
 *
 * @param hunks - Parsed diff hunks
 * @param startLine - Start line number (inclusive)
 * @param endLine - End line number (inclusive)
 * @returns Array of line contents, or null if any line not found
 */
export function getLineRange(
  hunks: DiffHunk[],
  startLine: number,
  endLine: number
): string[] | null {
  const lines: string[] = [];

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const content = getLineContent(hunks, lineNumber);
    if (content === null) {
      return null;
    }
    lines.push(content);
  }

  return lines;
}

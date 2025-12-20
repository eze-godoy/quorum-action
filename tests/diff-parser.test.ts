import { describe, expect, it } from 'vitest';

import {
  getLineContent,
  getLineRange,
  isLineInDiff,
  mapLineToPosition,
  parseDiff,
  parseHunkHeader,
  parsePatch,
} from '../src/diff-parser';

describe('parseHunkHeader', () => {
  it('parses standard hunk header', () => {
    const result = parseHunkHeader('@@ -10,5 +12,7 @@');
    expect(result).toEqual({
      oldStart: 10,
      oldCount: 5,
      newStart: 12,
      newCount: 7,
    });
  });

  it('parses hunk header without counts (defaults to 1)', () => {
    const result = parseHunkHeader('@@ -1 +1 @@');
    expect(result).toEqual({
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
    });
  });

  it('parses hunk header with context', () => {
    const result = parseHunkHeader('@@ -100,10 +105,15 @@ function test() {');
    expect(result).toEqual({
      oldStart: 100,
      oldCount: 10,
      newStart: 105,
      newCount: 15,
    });
  });

  it('returns null for invalid header', () => {
    expect(parseHunkHeader('not a header')).toBeNull();
    expect(parseHunkHeader('--- a/file.ts')).toBeNull();
    expect(parseHunkHeader('+++ b/file.ts')).toBeNull();
  });
});

describe('parsePatch', () => {
  it('parses simple addition', () => {
    const patch = `@@ -1,3 +1,4 @@
 line 1
 line 2
+new line
 line 3`;

    const hunks = parsePatch(patch);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].oldCount).toBe(3);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newCount).toBe(4);
    expect(hunks[0].lines).toHaveLength(4);

    expect(hunks[0].lines[0]).toEqual({
      type: 'context',
      content: 'line 1',
      oldLineNumber: 1,
      newLineNumber: 1,
    });
    expect(hunks[0].lines[2]).toEqual({
      type: 'addition',
      content: 'new line',
      newLineNumber: 3,
    });
  });

  it('parses deletion', () => {
    const patch = `@@ -1,4 +1,3 @@
 line 1
-deleted line
 line 2
 line 3`;

    const hunks = parsePatch(patch);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(4);

    expect(hunks[0].lines[1]).toEqual({
      type: 'deletion',
      content: 'deleted line',
      oldLineNumber: 2,
    });
  });

  it('parses multiple hunks', () => {
    const patch = `@@ -1,3 +1,4 @@
 first
+added
 context
@@ -10,2 +11,3 @@
 more
+another
 end`;

    const hunks = parsePatch(patch);

    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[1].oldStart).toBe(10);
  });

  it('handles empty patch', () => {
    const hunks = parsePatch('');
    expect(hunks).toEqual([]);
  });
});

describe('parseDiff', () => {
  it('parses single file diff', () => {
    const diff = `diff --git a/src/file.ts b/src/file.ts
index abc123..def456 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 line 1
+new line
 line 2
 line 3`;

    const files = parseDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('src/file.ts');
    expect(files[0].status).toBe('modified');
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(0);
    expect(files[0].hunks).toHaveLength(1);
  });

  it('parses new file', () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3`;

    const files = parseDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('src/new.ts');
    expect(files[0].status).toBe('added');
    expect(files[0].additions).toBe(3);
  });

  it('parses deleted file', () => {
    const diff = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line 1
-line 2`;

    const files = parseDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('src/old.ts');
    expect(files[0].status).toBe('removed');
    expect(files[0].deletions).toBe(2);
  });

  it('parses renamed file', () => {
    const diff = `diff --git a/src/old-name.ts b/src/new-name.ts
rename from src/old-name.ts
rename to src/new-name.ts
index abc1234..def5678 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,2 +1,2 @@
-old content
+new content
 same`;

    const files = parseDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('src/new-name.ts');
    expect(files[0].status).toBe('renamed');
  });

  it('parses multiple files', () => {
    const diff = `diff --git a/file1.ts b/file1.ts
index abc..def 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1,1 +1,2 @@
 content
+added
diff --git a/file2.ts b/file2.ts
new file mode 100644
index 0000000..abc 100644
--- /dev/null
+++ b/file2.ts
@@ -0,0 +1,1 @@
+new file content`;

    const files = parseDiff(diff);

    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe('file1.ts');
    expect(files[0].status).toBe('modified');
    expect(files[1].filename).toBe('file2.ts');
    expect(files[1].status).toBe('added');
  });

  it('handles empty diff', () => {
    const files = parseDiff('');
    expect(files).toEqual([]);
  });
});

describe('mapLineToPosition', () => {
  const patch = `@@ -1,4 +1,5 @@
 context 1
+added line
 context 2
-removed line
 context 3`;

  const hunks = parsePatch(patch);

  it('maps new file line to position', () => {
    // Line 1 is context, position 2 (after hunk header)
    expect(mapLineToPosition(hunks, 1, 'RIGHT')).toBe(2);
    // Line 2 is the added line, position 3
    expect(mapLineToPosition(hunks, 2, 'RIGHT')).toBe(3);
    // Line 3 is context, position 4
    expect(mapLineToPosition(hunks, 3, 'RIGHT')).toBe(4);
  });

  it('maps old file line to position', () => {
    // Line 1 is context, position 2
    expect(mapLineToPosition(hunks, 1, 'LEFT')).toBe(2);
    // Line 2 is context (old line 2), position 4
    expect(mapLineToPosition(hunks, 2, 'LEFT')).toBe(4);
    // Line 3 is the removed line, position 5
    expect(mapLineToPosition(hunks, 3, 'LEFT')).toBe(5);
  });

  it('returns null for line not in diff', () => {
    expect(mapLineToPosition(hunks, 100, 'RIGHT')).toBeNull();
    expect(mapLineToPosition(hunks, 100, 'LEFT')).toBeNull();
  });

  it('returns null for addition on LEFT side', () => {
    // The added line doesn't exist in the LEFT (old) side
    expect(mapLineToPosition(hunks, 2, 'LEFT')).not.toBe(3);
  });
});

describe('isLineInDiff', () => {
  const patch = `@@ -10,3 +10,4 @@
 context
+new
 more context`;

  const hunks = parsePatch(patch);

  it('returns true for lines in diff', () => {
    expect(isLineInDiff(hunks, 10, 'RIGHT')).toBe(true);
    expect(isLineInDiff(hunks, 11, 'RIGHT')).toBe(true);
    expect(isLineInDiff(hunks, 12, 'RIGHT')).toBe(true);
  });

  it('returns false for lines not in diff', () => {
    expect(isLineInDiff(hunks, 1, 'RIGHT')).toBe(false);
    expect(isLineInDiff(hunks, 100, 'RIGHT')).toBe(false);
  });
});

describe('getLineContent', () => {
  const patch = `@@ -1,2 +1,3 @@
 first line
+new line
 second line`;

  const hunks = parsePatch(patch);

  it('returns content for existing line', () => {
    expect(getLineContent(hunks, 1)).toBe('first line');
    expect(getLineContent(hunks, 2)).toBe('new line');
    expect(getLineContent(hunks, 3)).toBe('second line');
  });

  it('returns null for non-existent line', () => {
    expect(getLineContent(hunks, 100)).toBeNull();
  });
});

describe('getLineRange', () => {
  const patch = `@@ -1,2 +1,4 @@
 line 1
+line 2
+line 3
 line 4`;

  const hunks = parsePatch(patch);

  it('returns content for valid range', () => {
    const lines = getLineRange(hunks, 1, 3);
    expect(lines).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('returns null if any line is missing', () => {
    // Line 100 doesn't exist
    const lines = getLineRange(hunks, 1, 100);
    expect(lines).toBeNull();
  });

  it('handles single line range', () => {
    const lines = getLineRange(hunks, 2, 2);
    expect(lines).toEqual(['line 2']);
  });
});

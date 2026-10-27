/**
 * The structured output Claude Code attaches to a finished `Edit` or `Write` call (`tool_use_result` in the SDK stream,
 * `toolUseResult` in the transcript), for the scripted turns of `fake-claude-script.ts`. Agent Chat shows a file edit's
 * real diff from `structuredPatch`, so a scripted edit needs the patch Claude Code would have reported, with its line
 * numbers and context, not only the old and new text.
 */
import fs from 'node:fs';

import type { StructuredPatchHunk } from 'diff';
import { structuredPatch } from 'diff';

type Json = Record<string, unknown>;

/**
 * Unchanged lines Claude Code keeps on each side of a change in a patch hunk.
 */
const CONTEXT_LINES = 3;

/**
 * Files read to place a patch, so a runaway path cannot stall a turn.
 */
const MAX_FILE_BYTES = 1_000_000;

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * The file's text, or `undefined` when it is missing, unreadable, or too large to place a patch in.
 */
function readFile(filePath: string): string | undefined {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * The hunks that turn `original` into `next`, computed by the `diff` package whose hunk shape Claude Code reports, so a
 * line both sides share inside the change stays context instead of reading as removed and added again. No hunk when
 * nothing changed.
 */
function patchHunks(filePath: string, original: string, next: string): StructuredPatchHunk[] {
    return structuredPatch(filePath, filePath, original, next, undefined, undefined, {
        context: CONTEXT_LINES,
    }).hunks;
}

/**
 * Edit strings standing in for a missing file end without a newline; a file's last line has one, so the patch does not
 * mark both sides with "No newline at end of file".
 */
function asFileText(value: string): string {
    return value === '' || value.endsWith('\n') ? value : `${value}\n`;
}

function replaceText(content: string, search: string, replacement: string, isAll: boolean): string {
    // A replacer function keeps `$&` and similar patterns in the text literal.
    return isAll
        ? content.replaceAll(search, () => replacement)
        : content.replace(search, () => replacement);
}

/**
 * The file before and after an `Edit`. The file on disk places the change: one that still holds `old_string` is the
 * file before, one that already holds `new_string` (a Project seeded with the edit applied, so its Git panel agrees
 * with the Chat) is the file after. Without the file, the two strings alone stand for it.
 */
function editSides(input: Json, content: string | undefined): [string, string] {
    const oldString = text(input.old_string);
    const newString = text(input.new_string);
    const isAll = input.replace_all === true;
    const isBefore = content !== undefined && oldString !== '' && content.includes(oldString);
    const isAfter = content !== undefined && newString !== '' && content.includes(newString);
    // An edit that appends to existing code keeps `old_string` inside `new_string`, so a seeded "after" file holds both.
    if (isAfter && (!isBefore || newString.includes(oldString)))
        return [replaceText(content, newString, oldString, isAll), content];
    if (isBefore) return [content, replaceText(content, oldString, newString, isAll)];
    return [asFileText(oldString), asFileText(newString)];
}

/**
 * Claude Code's structured result for a finished `Edit` or `Write` (`structuredPatch`, and for `Write` `type: 'create'`
 * when it made a new file), or `undefined` for any other tool. A `Write` over a file that already holds its content is
 * a creation: the Project was seeded with the file the Chat reports writing.
 */
export function fileToolResult(name: string, input: Json): Json | undefined {
    const filePath = text(input.file_path);
    const content = readFile(filePath);
    if (name === 'Edit') {
        const [before, after] = editSides(input, content);
        return {
            filePath,
            oldString: text(input.old_string),
            newString: text(input.new_string),
            structuredPatch: patchHunks(filePath, before, after),
            userModified: false,
            replaceAll: input.replace_all === true,
        };
    }
    if (name !== 'Write') return undefined;
    const written = text(input.content);
    if (content === undefined || content === written)
        return {
            type: 'create',
            filePath,
            content: written,
            structuredPatch: [],
            originalFile: null,
        };
    return {
        type: 'update',
        filePath,
        content: written,
        structuredPatch: patchHunks(filePath, content, written),
        originalFile: content,
    };
}

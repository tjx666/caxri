/**
 * The structured output Claude Code attaches to a finished `Edit` or `Write` call (`tool_use_result` in the SDK stream,
 * `toolUseResult` in the transcript), for the scripted turns of `fake-claude-script.ts`. Agent Chat shows a file edit's
 * real diff from `structuredPatch`, so a scripted edit needs the patch Claude Code would have reported, with its line
 * numbers and context, not only the old and new text.
 */
import fs from 'node:fs';

type Json = Record<string, unknown>;

/**
 * Unchanged lines Claude Code keeps on each side of a change in a patch hunk.
 */
const CONTEXT_LINES = 3;

/**
 * Files read to place a patch, so a runaway path cannot stall a turn.
 */
const MAX_FILE_BYTES = 1_000_000;

interface PatchHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    /**
     * Context lines start with a space, removed lines with `-`, added lines with `+`.
     */
    lines: string[];
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function splitLines(content: string): string[] {
    return content === '' ? [] : content.replace(/\n$/u, '').split('\n');
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
 * The one hunk that turns `original` into `next`, like the `diff` package's: the lines both sides share at the start
 * and the end are context (at most three each), and the lines between them are the change. No hunk when nothing
 * changed.
 */
function structuredPatch(original: string[], next: string[]): PatchHunk[] {
    const shortest = Math.min(original.length, next.length);
    let prefix = 0;
    while (prefix < shortest && original[prefix] === next[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < shortest - prefix &&
        original[original.length - 1 - suffix] === next[next.length - 1 - suffix]
    )
        suffix += 1;
    if (prefix === original.length && prefix === next.length) return [];
    const before = Math.min(CONTEXT_LINES, prefix);
    const after = Math.min(CONTEXT_LINES, suffix);
    const removed = original.slice(prefix, original.length - suffix);
    const added = next.slice(prefix, next.length - suffix);
    const start = prefix - before + 1;
    return [
        {
            oldStart: start,
            oldLines: before + removed.length + after,
            newStart: start,
            newLines: before + added.length + after,
            lines: [
                ...original.slice(prefix - before, prefix).map((line) => ` ${line}`),
                ...removed.map((line) => `-${line}`),
                ...added.map((line) => `+${line}`),
                ...original
                    .slice(original.length - suffix, original.length - suffix + after)
                    .map((line) => ` ${line}`),
            ],
        },
    ];
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
    return [oldString, newString];
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
            structuredPatch: structuredPatch(splitLines(before), splitLines(after)),
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
        structuredPatch: structuredPatch(splitLines(content), splitLines(written)),
        originalFile: content,
    };
}

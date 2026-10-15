import type { GitFileStatus } from '../domain/git.js';
import type { AgentChatItem, AgentChatItemStatus } from './agent-chat-contract.js';
import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';

export type AgentChatFileChange = Extract<AgentChatItem, { type: 'fileChange' }>['changes'][number];

type AgentChatDiffLineKind = 'added' | 'removed' | 'context' | 'hunk' | 'meta';

export interface AgentChatDiffLine {
    kind: AgentChatDiffLineKind;
    /**
     * Line text without its unified-diff prefix column; hunk headers and meta lines keep their whole text.
     */
    text: string;
    oldLine?: number;
    newLine?: number;
}

export interface AgentChatDiffStat {
    additions: number;
    deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Splits text into lines without inventing an empty last line for a trailing newline.
 */
function splitLines(text: string): string[] {
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
}

/**
 * The bare `@@` line that opens a replacement body: Server Core's `replacementDiff` for a provider that reports an edit
 * as old and new text (Claude Code before its patch arrives, a Claude Code create, Grok Build) rather than as a patch
 * with line numbers.
 */
const REPLACEMENT_MARKER = '@@';

function isReplacementBody(lines: readonly string[]): boolean {
    return lines[0] === REPLACEMENT_MARKER;
}

/**
 * An added or deleted file's lines. Codex sends the whole content as is; a replacement body prefixes every line with
 * `+` or `-` under its `@@` marker, and neither the marker nor the prefix is part of the file.
 */
function wholeFileLines(text: string, kind: 'added' | 'removed'): AgentChatDiffLine[] {
    const lines = splitLines(text);
    const content = isReplacementBody(lines)
        ? lines.filter((line) => line !== REPLACEMENT_MARKER).map((line) => line.slice(1))
        : lines;
    return content.map((line, index) =>
        kind === 'added'
            ? { kind, text: line, newLine: index + 1 }
            : { kind, text: line, oldLine: index + 1 },
    );
}

/**
 * A unified diff read hunk by hunk. The header's line counts bound each hunk, so text after the last hunk (Codex
 * appends `Moved to: <path>` for a rename) reads as a note rather than as a context line, and a removed line that
 * itself starts with `--` is never mistaken for a file header.
 */
function unifiedDiffLines(text: string): AgentChatDiffLine[] {
    const lines = splitLines(text);
    if (lines.every((line) => !HUNK_HEADER.test(line))) return prefixedLines(lines);
    const result: AgentChatDiffLine[] = [];
    const cursor: HunkCursor = { oldLine: 0, newLine: 0, oldRemaining: 0, newRemaining: 0 };
    for (const line of lines) {
        const isInHunk = cursor.oldRemaining > 0 || cursor.newRemaining > 0;
        const header = isInHunk ? undefined : HUNK_HEADER.exec(line);
        if (header) {
            cursor.oldLine = Number(header[1]);
            cursor.oldRemaining = hunkLength(header[2]);
            cursor.newLine = Number(header[3]);
            cursor.newRemaining = hunkLength(header[4]);
            result.push({ kind: 'hunk', text: line });
        } else if (isInHunk) {
            result.push(hunkLine(line, cursor));
        } else if (line.trim()) {
            result.push({ kind: 'meta', text: line });
        }
    }
    return result;
}

/**
 * A hunk header omits its line count when it is one (`@@ -3 +3 @@`). An optional capture group that did not match is
 * `undefined` at runtime even though the match array types it as a string.
 */
function hunkLength(count: string | undefined): number {
    return count === undefined ? 1 : Number(count);
}

interface HunkCursor {
    oldLine: number;
    newLine: number;
    /**
     * Lines the current hunk header still promises on each side; both at zero means the hunk ended.
     */
    oldRemaining: number;
    newRemaining: number;
}

/**
 * Classifies one line inside a hunk and advances the cursor past it.
 */
function hunkLine(line: string, cursor: HunkCursor): AgentChatDiffLine {
    const prefix = line.charAt(0);
    if (prefix === '\\') return { kind: 'meta', text: line };
    if (prefix === '+') {
        cursor.newRemaining -= 1;
        return { kind: 'added', text: line.slice(1), newLine: cursor.newLine++ };
    }
    if (prefix === '-') {
        cursor.oldRemaining -= 1;
        return { kind: 'removed', text: line.slice(1), oldLine: cursor.oldLine++ };
    }
    // A context line; some producers strip the single space from an empty one.
    cursor.oldRemaining -= 1;
    cursor.newRemaining -= 1;
    return {
        kind: 'context',
        text: line.slice(1),
        oldLine: cursor.oldLine++,
        newLine: cursor.newLine++,
    };
}

/**
 * Fallback for an update without hunk headers: color by prefix alone, without line numbers.
 */
function prefixedLines(lines: string[]): AgentChatDiffLine[] {
    return lines.map((line) => {
        if (line === REPLACEMENT_MARKER) return { kind: 'hunk', text: line };
        if (line.startsWith('+++') || line.startsWith('---')) return { kind: 'meta', text: line };
        if (line.startsWith('+')) return { kind: 'added', text: line.slice(1) };
        if (line.startsWith('-')) return { kind: 'removed', text: line.slice(1) };
        return { kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line };
    });
}

/**
 * Display lines for one file change. Codex sends an added or deleted file's whole content rather than a patch
 * (`format_file_change_diff` in codex-rs `item_builders.rs`), so those read as all-added or all-removed lines; an
 * update is a unified diff.
 */
export function agentChatDiffLines(
    change: Pick<AgentChatFileChange, 'diff' | 'kind'>,
): AgentChatDiffLine[] {
    switch (change.kind) {
        case 'add': {
            return wholeFileLines(change.diff, 'added');
        }
        case 'delete': {
            return wholeFileLines(change.diff, 'removed');
        }
        case 'update': {
            return unifiedDiffLines(change.diff);
        }
    }
}

/**
 * Added and removed lines of one change, counted over the diff Server Core kept: a truncated diff counts only what is
 * shown.
 */
export function agentChatDiffStat(
    change: Pick<AgentChatFileChange, 'diff' | 'kind'>,
): AgentChatDiffStat {
    return agentChatDiffLinesStat(agentChatDiffLines(change));
}

export function agentChatDiffLinesStat(lines: readonly AgentChatDiffLine[]): AgentChatDiffStat {
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
        if (line.kind === 'added') additions += 1;
        else if (line.kind === 'removed') deletions += 1;
    }
    return { additions, deletions };
}

export function agentChatFileChangesStat(
    changes: ReadonlyArray<Pick<AgentChatFileChange, 'diff' | 'kind'>>,
): AgentChatDiffStat {
    return changes.reduce<AgentChatDiffStat>(
        (total, change) => {
            const stat = agentChatDiffStat(change);
            return {
                additions: total.additions + stat.additions,
                deletions: total.deletions + stat.deletions,
            };
        },
        { additions: 0, deletions: 0 },
    );
}

/**
 * The Git status a change kind reads as: the `GitFileStatus` kind and its single status letter. Desktop paints it with
 * the same letter and `--git-*` color as that file's row in Files and Source Control; it is structurally a Desktop
 * `GitDecoration`.
 */
export interface AgentChatChangeDecoration {
    kind: GitFileStatus['kind'];
    letter: string;
}

/**
 * The Git decoration a change kind reads as, so a Chat file header wears the same letter and color as that file's row
 * in Files and Source Control.
 */
export function agentChatChangeDecoration(
    kind: AgentChatFileChange['kind'],
): AgentChatChangeDecoration {
    switch (kind) {
        case 'add': {
            return { kind: 'added', letter: 'A' };
        }
        case 'delete': {
            return { kind: 'deleted', letter: 'D' };
        }
        case 'update': {
            return { kind: 'modified', letter: 'M' };
        }
    }
}

/**
 * The change kind in words, for the accessible name the status letter alone does not give.
 */
export function agentChatChangeKindLabel(
    kind: AgentChatFileChange['kind'],
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    return t(`agentChat.diff.kind.${kind}`);
}

/**
 * Whether the changed path exists on disk to open. Only a completed change has been applied: before that (pending
 * approval, declined, failed) an added file does not exist yet and a deleted one still does.
 */
export function canOpenAgentChatChange(
    kind: AgentChatFileChange['kind'],
    status: AgentChatItemStatus | undefined,
): boolean {
    return kind !== (status === 'completed' ? 'delete' : 'add');
}

/**
 * Where a hunk starts in the new file, read from its `@@ -a,b +c,d @@` header; `undefined` for a replacement body's
 * bare `@@` marker, which carries no position.
 */
export function agentChatHunkNewStart(header: string): number | undefined {
    const start = HUNK_HEADER.exec(header)?.[3];
    return start === undefined ? undefined : Number(start);
}

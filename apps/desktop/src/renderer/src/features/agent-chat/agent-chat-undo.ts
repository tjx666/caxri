import type { AgentChatDiffLine, AgentChatEditedFile, AgentChatFileChange } from '@caxri/protocol';
import { agentChatDiffLines, agentChatHunkNewStart } from '@caxri/protocol';

import { translate } from '../../i18n';

/**
 * Why a turn's change to a file cannot be undone:
 *
 * - `truncated`: Server Core cut the diff, so the original content is not fully known.
 * - `changed`: the file no longer holds what the turn left there, so reversing the patch would overwrite later work.
 * - `missing`: a file the turn changed or created is gone.
 * - `exists`: a file the turn deleted has been created again.
 */
export type AgentChatUndoFailure = 'truncated' | 'changed' | 'missing' | 'exists';

/**
 * What undoing one file does to disk: rewrite it, move a file the turn created to the Trash, or recreate a file the
 * turn deleted. `none` when the file already holds its content from before the turn, such as a turn already undone
 * before a window reload.
 */
export type AgentChatUndoStep =
    | { path: string; action: 'write' | 'restore'; content: string }
    | { path: string; action: 'trash' | 'none' };

export type AgentChatUndoPlan =
    | { ok: true; step: AgentChatUndoStep }
    | { ok: false; path: string; reason: AgentChatUndoFailure };

/**
 * One hunk, as the blocks of lines it turned `oldLines` into `newLines`, and where each block started when the diff
 * says.
 */
interface ReversibleHunk {
    oldStart?: number;
    newStart?: number;
    oldLines: string[];
    newLines: string[];
}

/**
 * One hunk applied in one direction: the lines expected in the file now (`found`, starting at line `start` when the
 * diff says), and what replaces them.
 */
interface HunkRewrite {
    start?: number;
    found: readonly string[];
    replacement: readonly string[];
}

/**
 * The old-file start of a `@@ -a,b +c,d @@` header. The protocol only exposes the new-file start, which is all Undo
 * needed until it also had to replay a turn forward.
 */
const HUNK_OLD_START = /^@@ -(\d+)(?:,\d+)? \+/u;

const withoutCarriageReturn = (line: string): string => line.replace(/\r$/u, '');

/**
 * Diff lines split on `\n` keep a CRLF file's `\r`; it is dropped here because the file is rejoined with its own line
 * ending, which would otherwise double it.
 */
function addHunkLine(hunk: ReversibleHunk, line: AgentChatDiffLine): void {
    const text = withoutCarriageReturn(line.text);
    if (line.kind !== 'added') hunk.oldLines.push(text);
    if (line.kind !== 'removed') hunk.newLines.push(text);
}

function hunkAt(header: string): ReversibleHunk {
    const newStart = agentChatHunkNewStart(header);
    const oldStart = HUNK_OLD_START.exec(header)?.[1];
    return {
        oldLines: [],
        newLines: [],
        ...(newStart !== undefined && { newStart }),
        ...(oldStart !== undefined && { oldStart: Number(oldStart) }),
    };
}

function hunksOf(change: AgentChatFileChange): ReversibleHunk[] {
    const hunks: ReversibleHunk[] = [];
    let hunk: ReversibleHunk | undefined;
    const current = (): ReversibleHunk => {
        if (!hunk) {
            hunk = { oldLines: [], newLines: [] };
            hunks.push(hunk);
        }
        return hunk;
    };
    for (const line of agentChatDiffLines(change)) {
        if (line.kind === 'hunk') {
            hunk = hunkAt(line.text);
            hunks.push(hunk);
        } else if (line.kind !== 'meta') {
            addHunkLine(current(), line);
        }
    }
    return hunks.filter((entry) => entry.oldLines.length > 0 || entry.newLines.length > 0);
}

function isMatchAt(lines: readonly string[], block: readonly string[], start: number): boolean {
    return block.every(
        (line, offset) =>
            start + offset < lines.length &&
            withoutCarriageReturn(lines.at(start + offset) ?? '') === withoutCarriageReturn(line),
    );
}

/**
 * Fewer lines than this can recur by chance, so a hunk that moved from its diff position needs at least this many to be
 * found elsewhere.
 */
const MIN_RELOCATABLE_LINES = 3;

/**
 * Where a rewrite's expected lines sit in the file now, or `undefined` when that cannot be told for sure. Undo only
 * ever writes what it can verify, so unlike `patch` it applies no fuzz: the lines must be at the diff's position, or
 * appear exactly once and be long enough not to match unrelated code. A rewrite that expects no lines and kept no
 * context is verifiable only against an empty file. A replacement with no position and nothing to put back (Claude
 * Code's `Write` before its patch arrives, undone) names nothing to restore.
 */
function locate(lines: readonly string[], rewrite: HunkRewrite): number | undefined {
    const { start, found, replacement } = rewrite;
    if (found.length === 0)
        return start === 0 && lines.every((line) => line === '') ? 0 : undefined;
    if (start === undefined && replacement.length === 0) return undefined;
    if (start !== undefined && isMatchAt(lines, found, start - 1)) return start - 1;
    if (start !== undefined && found.length < MIN_RELOCATABLE_LINES) return undefined;
    const candidates: number[] = [];
    for (let index = 0; index + found.length <= lines.length; index += 1)
        if (isMatchAt(lines, found, index)) candidates.push(index);
    return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Applies rewrites bottom-up, so an earlier hunk's position is not shifted by a later one; `undefined` when any no
 * longer matches.
 */
function rewriteContent(content: string, rewrites: readonly HunkRewrite[]): string | undefined {
    if (rewrites.length === 0) return undefined;
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/u);
    const ordered = rewrites.every((rewrite) => rewrite.start !== undefined)
        ? rewrites.toSorted((left, right) => (right.start ?? 0) - (left.start ?? 0))
        : rewrites.toReversed();
    for (const rewrite of ordered) {
        const start = locate(lines, rewrite);
        if (start === undefined) return undefined;
        lines.splice(start, rewrite.found.length, ...rewrite.replacement);
    }
    return lines.join(eol);
}

/**
 * The file content before one update, or `undefined` when a hunk no longer matches.
 */
export function revertAgentChatUpdate(
    content: string,
    change: AgentChatFileChange,
): string | undefined {
    return rewriteContent(
        content,
        hunksOf(change).map((hunk) => ({
            ...(hunk.newStart !== undefined && { start: hunk.newStart }),
            found: hunk.newLines,
            replacement: hunk.oldLines,
        })),
    );
}

/**
 * The file content after one update, replayed forward from its content before it, or `undefined` when a hunk does not
 * match. Undo uses it only to recognize a file that already holds its content from before the turn.
 */
function replayAgentChatUpdate(content: string, change: AgentChatFileChange): string | undefined {
    return rewriteContent(
        content,
        hunksOf(change).map((hunk) => ({
            ...(hunk.oldStart !== undefined && { start: hunk.oldStart }),
            found: hunk.oldLines,
            replacement: hunk.newLines,
        })),
    );
}

/**
 * A whole file's content as the change carried it, without the line prefix or marker a replacement body adds.
 */
function wholeContent(change: AgentChatFileChange): string {
    const lines = agentChatDiffLines(change).map((line) => line.text);
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

const isSameContent = (left: string, right: string): boolean =>
    left.replaceAll('\r\n', '\n').replace(/\n+$/u, '') ===
    right.replaceAll('\r\n', '\n').replace(/\n+$/u, '');

/**
 * The file's content before one change, from its content after it (`undefined` for a file that does not exist).
 */
function revertChange(
    content: string | undefined,
    change: AgentChatFileChange,
): { ok: true; content: string | undefined } | { ok: false; reason: AgentChatUndoFailure } {
    switch (change.kind) {
        case 'add': {
            if (content === undefined) return { ok: false, reason: 'missing' };
            return isSameContent(content, wholeContent(change))
                ? { ok: true, content: undefined }
                : { ok: false, reason: 'changed' };
        }
        case 'delete': {
            return content === undefined
                ? { ok: true, content: wholeContent(change) }
                : { ok: false, reason: 'exists' };
        }
        case 'update': {
            if (content === undefined) return { ok: false, reason: 'missing' };
            const reverted = revertAgentChatUpdate(content, change);
            return reverted === undefined
                ? { ok: false, reason: 'changed' }
                : { ok: true, content: reverted };
        }
    }
}

/**
 * The file's content after one change, from its content before it, or `false` when the change does not apply.
 */
function replayChange(
    content: string | undefined,
    change: AgentChatFileChange,
): { ok: true; content: string | undefined } | { ok: false } {
    switch (change.kind) {
        case 'add': {
            return content === undefined
                ? { ok: true, content: wholeContent(change) }
                : { ok: false };
        }
        case 'delete': {
            return content !== undefined && isSameContent(content, wholeContent(change))
                ? { ok: true, content: undefined }
                : { ok: false };
        }
        case 'update': {
            if (content === undefined) return { ok: false };
            const replayed = replayAgentChatUpdate(content, change);
            return replayed === undefined ? { ok: false } : { ok: true, content: replayed };
        }
    }
}

/**
 * Whether the file already holds its content from before the turn: every change the turn made applies to it again,
 * oldest first. Undo state lives in memory only, so after a window reload a turn undone earlier offers Undo again, and
 * without this check its file would read as "changed after the Agent edited it". Asked only once reversing the turn
 * failed, because a change that only appends lines can match both before and after it.
 */
function isAtPreTurnState(file: AgentChatEditedFile, current: string | undefined): boolean {
    let content = current;
    for (const change of file.changes) {
        const replayed = replayChange(content, change);
        if (!replayed.ok) return false;
        content = replayed.content;
    }
    return file.changes.length > 0;
}

/**
 * Plans undoing every change a turn made to one file, replaying them newest first against the file as it is now
 * (`undefined` when it does not exist). Nothing is written here; the caller plans every file before touching any.
 */
export function planAgentChatFileUndo(
    file: AgentChatEditedFile,
    current: string | undefined,
): AgentChatUndoPlan {
    const fail = (reason: AgentChatUndoFailure): AgentChatUndoPlan => ({
        ok: false,
        path: file.path,
        reason,
    });
    if (file.truncated) return fail('truncated');
    const { path } = file;
    let content = current;
    for (const change of file.changes.toReversed()) {
        const reverted = revertChange(content, change);
        if (!reverted.ok)
            return isAtPreTurnState(file, current)
                ? { ok: true, step: { path, action: 'none' } }
                : fail(reverted.reason);
        content = reverted.content;
    }
    if (current === undefined)
        return {
            ok: true,
            step:
                content === undefined
                    ? { path, action: 'none' }
                    : { path, action: 'restore', content },
        };
    if (content === undefined) return { ok: true, step: { path, action: 'trash' } };
    return {
        ok: true,
        step: content === current ? { path, action: 'none' } : { path, action: 'write', content },
    };
}

/**
 * One file as a completed Undo left it, kept so the Undo can be taken back: its content before the Undo and the content
 * the Undo wrote (`undefined` for a file that did not exist at that point).
 */
export interface AgentChatRedoFile {
    path: string;
    displayPath: string;
    before: string | undefined;
    after: string | undefined;
}

export type AgentChatRedoFailure = Exclude<AgentChatUndoFailure, 'truncated'>;

export type AgentChatRedoPlan =
    | { ok: true; step: AgentChatUndoStep }
    | { ok: false; path: string; reason: AgentChatRedoFailure };

/**
 * Plans putting back what an Undo replaced in one file. Like Undo it refuses to overwrite later work: the file must
 * hold exactly what the Undo wrote, or still be absent when the Undo trashed it.
 */
export function planAgentChatFileRedo(
    file: AgentChatRedoFile,
    current: string | undefined,
): AgentChatRedoPlan {
    const { path, before, after } = file;
    if (current !== after) {
        const reason: AgentChatRedoFailure =
            after === undefined ? 'exists' : current === undefined ? 'missing' : 'changed';
        return { ok: false, path, reason };
    }
    if (before === undefined) return { ok: true, step: { path, action: 'trash' } };
    return {
        ok: true,
        step: { path, action: current === undefined ? 'restore' : 'write', content: before },
    };
}

/**
 * The toast that explains why nothing was redone, naming the first file that blocked it.
 */
export function agentChatRedoFailureMessage(
    displayPath: string,
    reason: AgentChatRedoFailure,
): string {
    return translate('agentChat.redo.failure', {
        path: displayPath,
        reason: translate(`agentChat.redo.failureReason.${reason}`),
    });
}

/**
 * The toast after a Redo put back every file the Undo restored.
 */
export function agentChatRedoSuccessMessage(fileCount: number): string {
    return fileCount === 1
        ? translate('agentChat.redo.successOne')
        : translate('agentChat.redo.successOther', { count: fileCount });
}

/**
 * The next step for a failure the user can work around. A file that changed after the turn is usually a later turn
 * editing it again, so the toast points at undoing that turn first or at Restore Code to Here, which reverts every turn
 * from a message onward from the provider's own checkpoints instead of reversing this turn's diff.
 */
function failureNextStep(reason: AgentChatUndoFailure): string | undefined {
    return reason === 'changed' ? translate('agentChat.undo.nextStep.changed') : undefined;
}

/**
 * The toast that explains why nothing was undone, naming the first file that blocked it and, when there is one, what to
 * do instead.
 */
export function agentChatUndoFailureMessage(
    displayPath: string,
    reason: AgentChatUndoFailure,
): string {
    const nextStep = failureNextStep(reason);
    const message = translate('agentChat.undo.failure', {
        path: displayPath,
        reason: translate(`agentChat.undo.failureReason.${reason}`),
    });
    return nextStep ? `${message} ${nextStep}` : message;
}

/**
 * The toast after an Undo restored every file the turn changed.
 */
export function agentChatUndoSuccessMessage(fileCount: number): string {
    return fileCount === 1
        ? translate('agentChat.undo.successOne')
        : translate('agentChat.undo.successOther', { count: fileCount });
}

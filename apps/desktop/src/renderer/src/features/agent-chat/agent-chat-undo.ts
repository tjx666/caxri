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
 * turn deleted. `none` when the file already holds its content from before the turn.
 */
export type AgentChatUndoStep =
    | { path: string; action: 'write' | 'restore'; content: string }
    | { path: string; action: 'trash' | 'none' };

export type AgentChatUndoPlan =
    | { ok: true; step: AgentChatUndoStep }
    | { ok: false; path: string; reason: AgentChatUndoFailure };

/**
 * One hunk, as the blocks of lines it turned `oldLines` into `newLines`, and where `newLines` started when the diff
 * says.
 */
interface ReversibleHunk {
    newStart?: number;
    oldLines: string[];
    newLines: string[];
}

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
            const newStart = agentChatHunkNewStart(line.text);
            hunk = { oldLines: [], newLines: [], ...(newStart !== undefined && { newStart }) };
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
 * Fewer new lines than this can recur by chance, so a hunk that moved from its diff position needs at least this many
 * to be found elsewhere.
 */
const MIN_RELOCATABLE_LINES = 3;

/**
 * Where a hunk's new lines sit in the file now, or `undefined` when that cannot be told for sure. Undo only ever writes
 * what it can verify, so unlike `patch` it applies no fuzz: the lines must be at the diff's position, or appear exactly
 * once and be long enough not to match unrelated code. A hunk that only removed lines and kept no context is verifiable
 * only when it emptied the file. A replacement with no original lines (Claude Code's `Write` before its patch arrives)
 * names nothing to restore.
 */
function locate(lines: readonly string[], hunk: ReversibleHunk): number | undefined {
    if (hunk.newLines.length === 0)
        return hunk.newStart === 0 && lines.every((line) => line === '') ? 0 : undefined;
    if (hunk.newStart === undefined && hunk.oldLines.length === 0) return undefined;
    if (hunk.newStart !== undefined && isMatchAt(lines, hunk.newLines, hunk.newStart - 1))
        return hunk.newStart - 1;
    if (hunk.newStart !== undefined && hunk.newLines.length < MIN_RELOCATABLE_LINES)
        return undefined;
    const candidates: number[] = [];
    for (let start = 0; start + hunk.newLines.length <= lines.length; start += 1)
        if (isMatchAt(lines, hunk.newLines, start)) candidates.push(start);
    return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The file content before one update, or `undefined` when a hunk no longer matches. Hunks reverse bottom-up so an
 * earlier hunk's position is not shifted by a later one.
 */
export function revertAgentChatUpdate(
    content: string,
    change: AgentChatFileChange,
): string | undefined {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/u);
    const hunks = hunksOf(change);
    if (hunks.length === 0) return undefined;
    const ordered = hunks.every((hunk) => hunk.newStart !== undefined)
        ? hunks.toSorted((left, right) => (right.newStart ?? 0) - (left.newStart ?? 0))
        : hunks.toReversed();
    for (const hunk of ordered) {
        const start = locate(lines, hunk);
        if (start === undefined) return undefined;
        lines.splice(start, hunk.newLines.length, ...hunk.oldLines);
    }
    return lines.join(eol);
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
    let content = current;
    for (const change of file.changes.toReversed()) {
        const reverted = revertChange(content, change);
        if (!reverted.ok) return fail(reverted.reason);
        content = reverted.content;
    }
    const { path } = file;
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

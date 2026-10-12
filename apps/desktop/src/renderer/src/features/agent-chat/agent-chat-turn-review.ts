import type {
    AgentChatDiffLine,
    AgentChatEditedFile,
    AgentChatItem,
    ReviewCommentText,
} from '@caxri/protocol';
import {
    agentChatDiffLines,
    collectAgentChatEditedFiles,
    formatReviewComment,
} from '@caxri/protocol';

/**
 * Where a review comment says it came from, so the Agent can tell it apart from a Git diff review.
 */
const REVIEW_SOURCE = 'Agent turn diff';

const SIGN: Partial<Record<AgentChatDiffLine['kind'], string>> = {
    added: '+',
    removed: '-',
    context: ' ',
};

/**
 * One file of a turn under review, with the diff lines its comments anchor to. A turn that edited the file several
 * times shows each edit's patch after the previous one, and each patch numbers its lines against the file as that edit
 * found it, so `edits` and `hunks` record which edit and which hunk every line belongs to.
 */
export interface AgentChatReviewFile {
    file: AgentChatEditedFile;
    lines: AgentChatDiffLine[];
    /**
     * The index into `file.changes` of the edit each line came from.
     */
    edits: number[];
    /**
     * An ordinal per hunk, counted across the whole file, for each line. A comment never spans two hunks: their line
     * numbers need not be contiguous, or even from the same edit.
     */
    hunks: number[];
}

function reviewFile(file: AgentChatEditedFile): AgentChatReviewFile {
    const lines: AgentChatDiffLine[] = [];
    const edits: number[] = [];
    const hunks: number[] = [];
    let hunk = -1;
    for (const [edit, change] of file.changes.entries()) {
        hunk += 1;
        for (const [index, line] of agentChatDiffLines(change).entries()) {
            if (line.kind === 'hunk' && index > 0) hunk += 1;
            lines.push(line);
            edits.push(edit);
            hunks.push(hunk);
        }
    }
    return { file, lines, edits, hunks };
}

/**
 * The files one turn changed, each merged across every edit the turn made to it, the same files the turn's `Edited N
 * files` card lists.
 */
export function collectAgentChatTurnReview(
    items: readonly AgentChatItem[],
    turnId: string,
): AgentChatReviewFile[] {
    return collectAgentChatEditedFiles(items.filter((item) => item.turnId === turnId)).map(
        reviewFile,
    );
}

/**
 * Whether a comment can start or end on this line: a line of code, not a hunk header or a note.
 */
export function isAgentChatReviewableLine(line: AgentChatDiffLine | undefined): boolean {
    return line?.kind === 'added' || line?.kind === 'removed' || line?.kind === 'context';
}

/**
 * The lines a comment covers, as indexes into one file's diff lines, `start` never after `end`.
 */
export interface AgentChatReviewRange {
    start: number;
    end: number;
}

/**
 * The range from `anchor` to `index` in either direction: Shift-clicking a second line extends a comment's range. A
 * line in another hunk starts a new range instead, since one citation cannot cover two hunks' line numbers.
 */
export function agentChatReviewRange(
    file: Pick<AgentChatReviewFile, 'hunks'>,
    anchor: number,
    index: number,
): AgentChatReviewRange {
    if (file.hunks[anchor] !== file.hunks[index]) return { start: index, end: index };
    return { start: Math.min(anchor, index), end: Math.max(anchor, index) };
}

/**
 * A review comment with the source it cites, which names the edit when the turn edited the file more than once: that
 * edit's line numbers are where its lines were when it ran, and a later edit may have moved them.
 */
export interface AgentChatReviewComment extends ReviewCommentText {
    source: string;
}

/**
 * What a comment on `range` cites. Lines that are all removed cite the old file's line numbers; any other range cites
 * the new file's. The snippet keeps each line's diff sign, so the Agent sees what changed as well as where.
 */
export function agentChatReviewComment(
    file: AgentChatReviewFile,
    range: AgentChatReviewRange,
    text: string,
): AgentChatReviewComment | undefined {
    const selected = file.lines
        .slice(range.start, range.end + 1)
        .filter((line) => isAgentChatReviewableLine(line));
    const isOriginal = selected.every((line) => line.kind === 'removed');
    const numbers = selected.flatMap((line) => {
        const number = isOriginal ? line.oldLine : line.newLine;
        return number === undefined ? [] : [number];
    });
    if (numbers.length === 0) return undefined;
    const editCount = file.file.changes.length;
    const edit = (file.edits[range.start] ?? 0) + 1;
    return {
        path: file.file.path,
        source: editCount > 1 ? `${REVIEW_SOURCE}, edit ${edit} of ${editCount}` : REVIEW_SOURCE,
        side: isOriginal ? 'original' : 'modified',
        startLine: Math.min(...numbers),
        endLine: Math.max(...numbers),
        snippet: selected.map((line) => `${SIGN[line.kind] ?? ''}${line.text}`).join('\n'),
        text: text.trim(),
    };
}

/**
 * A comment as it lands in the Chat's composer, in the same form a Git diff review sends to an Agent.
 */
export function formatAgentChatReviewComment(
    comment: AgentChatReviewComment,
    projectRoot: string | undefined,
): string {
    return formatReviewComment(comment, projectRoot, comment.source, 'diff');
}
